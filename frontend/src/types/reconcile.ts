/**
 * 对账领域：台网中心账（台站 + 停测时段）与计量站账（标定 / 灵敏度 / 响应结论）
 * 按台站码逐站核对。
 *
 * 规则：
 * - 对账键只有台站码，两侧都只认自己名下的字段，不互相改写；
 * - 对账失败由台网中心侧发起重试（重新对账），计量站侧只读；
 * - 计量站已认过（acknowledgedAt 有值）的响应结论，重试时不回退；
 * - 中心标了停测但没登记停测时段的台站，单列"待补时段"，不判任何一方失败。
 */
import type { SeisStation } from '@/types/station';
import type { SuspensionWindow } from '@/types/suspension';
import type { Calibration } from '@/types/calibration';
import type { Instrument } from '@/types/instrument';

/** 单行对账结果 */
export type ReconcileStatus = 'matched' | 'center-missing' | 'calibration-missing' | 'duplicated-code';

export const RECONCILE_STATUS_LABEL: Record<ReconcileStatus, string> = {
  matched: '对平',
  'center-missing': '中心缺台站',
  'calibration-missing': '计量站缺标定',
  'duplicated-code': '台站码重复',
};

/** 计量站侧按台站码聚合的账 */
export interface CalibStationLedger {
  stationCode: string;
  instruments: Instrument[];
  calibrations: Calibration[];
  /** 最近一次标定日期 */
  latestCalibrationDate: string | null;
  /** 是否已被中心认过账（至少一条标定有 acknowledgedAt） */
  acknowledged: boolean;
}

/** 中心侧按台站码聚合的账 */
export interface CenterStationLedger {
  stationCode: string;
  station: SeisStation | null;
  windows: SuspensionWindow[];
}

export interface ReconcileItem {
  /** 对账键：台站码 */
  stationCode: string;
  status: ReconcileStatus;
  /** 失败原因（对平时为空） */
  reason: string;
  /** 中心侧台账（可能缺） */
  center: CenterStationLedger | null;
  /** 计量站侧台账（可能缺） */
  calib: CalibStationLedger | null;
  /** 计量站认账时间（最新一条 acknowledgedAt），用于展示"已认过、重试不回退" */
  acknowledgedAt: number | null;
}

export interface ReconcileReport {
  /** 对账基准时间 */
  reconciledAt: number;
  total: number;
  matched: number;
  failed: number;
  items: ReconcileItem[];
}

/** 把计量站的仪器 + 标定按台站码聚合成账（入参 station 仅用于 id → code） */
export function buildCalibLedgers(params: {
  stations: SeisStation[];
  instruments: Instrument[];
  calibrations: Calibration[];
}): CalibStationLedger[] {
  const stationCodeById = new Map(params.stations.map((station) => [station.id, station.code]));
  const byCode = new Map<string, CalibStationLedger>();

  const ensure = (code: string): CalibStationLedger => {
    let ledger = byCode.get(code);
    if (!ledger) {
      ledger = {
        stationCode: code,
        instruments: [],
        calibrations: [],
        latestCalibrationDate: null,
        acknowledged: false,
      };
      byCode.set(code, ledger);
    }
    return ledger;
  };

  params.instruments.forEach((instrument) => {
    const code = stationCodeById.get(instrument.stationId);
    // 台站档案缺失的仪器：用「?<stationId>」占位码挂账，由对账判中心侧缺档案
    ensure(code ?? `?${instrument.stationId}`).instruments.push(instrument);
  });

  params.calibrations.forEach((calibration) => {
    const instrument = params.instruments.find((row) => row.id === calibration.instrumentId);
    const code = instrument ? stationCodeById.get(instrument.stationId) : undefined;
    if (!instrument) return;
    ensure(code ?? `?${instrument.stationId}`).calibrations.push(calibration);
  });

  byCode.forEach((ledger) => {
    ledger.instruments.sort((a, b) => a.installDate.localeCompare(b.installDate));
    ledger.calibrations.sort((a, b) => b.date.localeCompare(a.date));
    ledger.latestCalibrationDate = ledger.calibrations[0]?.date ?? null;
    ledger.acknowledged = ledger.calibrations.some((row) => typeof row.acknowledgedAt === 'number');
  });

  return [...byCode.values()].sort((a, b) => a.stationCode.localeCompare(b.stationCode, 'zh-Hans-CN'));
}

/** 中心侧按台站码聚合（含停测时段） */
export function buildCenterLedgers(params: {
  stations: SeisStation[];
  windows: SuspensionWindow[];
}): CenterStationLedger[] {
  const byCode = new Map<string, CenterStationLedger>();
  params.stations.forEach((station) => {
    byCode.set(station.code, { stationCode: station.code, station, windows: [] });
  });
  params.windows.forEach((window) => {
    const ledger =
      byCode.get(window.stationCode) ??
      ({ stationCode: window.stationCode, station: null, windows: [] } as CenterStationLedger);
    ledger.windows.push(window);
    byCode.set(window.stationCode, ledger);
  });
  byCode.forEach((ledger) => ledger.windows.sort((a, b) => a.startDate.localeCompare(b.startDate)));
  return [...byCode.values()].sort((a, b) => a.stationCode.localeCompare(b.stationCode, 'zh-Hans-CN'));
}

/**
 * 纯函数：按台站码对两本账。
 * 不做任何写入；"认过不回退"在执行对账的动作里依据 item.acknowledgedAt 处理。
 */
export function reconcileLedgers(params: {
  stations: SeisStation[];
  windows: SuspensionWindow[];
  instruments: Instrument[];
  calibrations: Calibration[];
  now?: number;
}): ReconcileReport {
  const now = params.now ?? Date.now();
  const centerLedgers = buildCenterLedgers({ stations: params.stations, windows: params.windows });
  const calibLedgers = buildCalibLedgers({
    stations: params.stations,
    instruments: params.instruments,
    calibrations: params.calibrations,
  });
  const centerByCode = new Map(centerLedgers.map((ledger) => [ledger.stationCode, ledger]));
  const calibByCode = new Map(calibLedgers.map((ledger) => [ledger.stationCode, ledger]));

  // 台站码重复（中心档案侧）：直接判失败，要求中心先纠正
  const codeCount = new Map<string, number>();
  params.stations.forEach((station) => codeCount.set(station.code, (codeCount.get(station.code) ?? 0) + 1));
  const duplicated = new Set([...codeCount].filter(([, count]) => count > 1).map(([code]) => code));

  const codes = new Set<string>([...centerByCode.keys(), ...calibByCode.keys()]);
  const items: ReconcileItem[] = [...codes]
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
    .map((code) => {
      const center = centerByCode.get(code) ?? null;
      const calib = calibByCode.get(code) ?? null;
      const acknowledgedAt =
        calib?.calibrations.reduce<number | null>(
          (max, row) => (typeof row.acknowledgedAt === 'number' ? Math.max(max ?? 0, row.acknowledgedAt) : max),
          null
        ) ?? null;

      if (duplicated.has(code)) {
        return {
          stationCode: code,
          status: 'duplicated-code' as const,
          reason: '台网中心存在重复台站码，需先合并或更正后重试',
          center,
          calib,
          acknowledgedAt,
        };
      }
      if (!center) {
        return {
          stationCode: code,
          status: 'center-missing' as const,
          reason: '计量站有该台站码的仪器 / 标定，台网中心无台站档案',
          center,
          calib,
          acknowledgedAt,
        };
      }
      if (!calib || calib.instruments.length === 0 || calib.calibrations.length === 0) {
        return {
          stationCode: code,
          status: 'calibration-missing' as const,
          reason: '中心有台站档案，计量站尚无标定记录',
          center,
          calib,
          acknowledgedAt,
        };
      }
      return {
        stationCode: code,
        status: 'matched' as const,
        reason: '',
        center,
        calib,
        acknowledgedAt,
      };
    });

  const matched = items.filter((item) => item.status === 'matched').length;
  return {
    reconciledAt: now,
    total: items.length,
    matched,
    failed: items.length - matched,
    items,
  };
}
