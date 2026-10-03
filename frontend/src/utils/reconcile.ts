/**
 * 台站码对账引擎（台网中心 ↔ 计量站）。
 *
 * 输入两边各自的数据（不跨库写对方表），按台站码产出对账台账：
 * - matched：中心有台站，计量侧有仪器/标定，台站码对得上；
 * - station_only：只有中心台站，计量侧尚未建档；
 * - orphan：计量侧有仪器/标定，中心查无此台站码（重试责任在中心）；
 * - suspension_missing：台站处于停测但中心未登记停测时段，计量侧挂起暂不算超期。
 *
 * 计量站认过的结论不回退：重试时把上一轮台账传入，matched 行保留其已认结论与对账时间，
 * 只有非 matched 行（或已消失/变化的行）才重新计算。
 */
import type { SeisStation } from '@/types/station';
import type { SeisArray } from '@/types/array';
import type { Instrument } from '@/types/instrument';
import type { Calibration, ResponseVerdict } from '@/types/calibration';
import type { Suspension } from '@/types/suspension';
import {
  type Reconciliation,
  type ReconcileReport,
  type ReconcileStatus,
} from '@/types/reconciliation';

const VERDICT_ORDER: Record<ResponseVerdict, number> = { 不合格: 2, 待判定: 1, 合格: 0 };

export interface ReconcileInput {
  arrays: SeisArray[];
  stations: SeisStation[];
  instruments: Instrument[];
  calibrations: Calibration[];
  suspensions: Suspension[];
  /** 上一轮台账（重试时传入），用于保住 matched 行已认结论 */
  previous?: Reconciliation[];
  /** 评定基准时间戳（默认现在） */
  now?: number;
}

/** 取一组标定中最差的响应结论文案（无标定返回空串） */
export function worstVerdictLabel(calibrations: Calibration[]): string {
  if (calibrations.length === 0) return '';
  return calibrations.reduce<ResponseVerdict>((worst, row) => {
    return VERDICT_ORDER[row.responseVerdict] > VERDICT_ORDER[worst] ? row.responseVerdict : worst;
  }, '合格');
}

/**
 * 执行一次全量对账。中心侧重试就是重新跑本函数并传入上一轮台账。
 */
export function reconcileSides(input: ReconcileInput): ReconcileReport {
  const now = input.now ?? Date.now();
  const previousMap = new Map((input.previous ?? []).map((row) => [row.stationCode, row]));

  const arrayNameOf = (arrayId: string): string =>
    input.arrays.find((array) => array.id === arrayId)?.name ?? '未知台阵';

  // 中心侧：台站码 → 台站
  const centerByCode = new Map<string, SeisStation>();
  input.stations.forEach((station) => {
    if (!centerByCode.has(station.code)) centerByCode.set(station.code, station);
  });

  // 计量侧：台站码 → 仪器（仪器经 stationId 挂台站，台站码向中心查）
  const stationIdToCode = new Map(input.stations.map((station) => [station.id, station.code]));
  const metrologyByCode = new Map<
    string,
    { instruments: Instrument[]; calibrations: Calibration[] }
  >();

  const ensureBucket = (code: string) => {
    let bucket = metrologyByCode.get(code);
    if (!bucket) {
      bucket = { instruments: [], calibrations: [] };
      metrologyByCode.set(code, bucket);
    }
    return bucket;
  };

  input.instruments.forEach((instrument) => {
    const code = stationIdToCode.get(instrument.stationId);
    // 仪器台站在中心缺失时无法得到台站码：这类孤儿由「孤立标定」之外的路径难以挂码，
    // 这里以仪器所属台站 id 兜底收集，真正的 orphan 主路径见下方孤立仪器扫描。
    if (code) ensureBucket(code).instruments.push(instrument);
  });

  // 台站 id → 仪器 ids，便于挂标定
  const calibrationsByInstrument = new Map<string, Calibration[]>();
  input.calibrations.forEach((calibration) => {
    const list = calibrationsByInstrument.get(calibration.instrumentId) ?? [];
    list.push(calibration);
    calibrationsByInstrument.set(calibration.instrumentId, list);
  });

  input.instruments.forEach((instrument) => {
    const code = stationIdToCode.get(instrument.stationId);
    if (!code) return;
    const bucket = ensureBucket(code);
    calibrationsByInstrument.get(instrument.id)?.forEach((calibration) => bucket.calibrations.push(calibration));
  });

  // 孤立仪器：仪器的 stationId 在中心查无台站（数据残留），用「未知台站码」无法按码对账，
  // 改为扫描标定/仪器中台站码与中心不匹配的集合。正常路径以台站码为准。
  const orphanStationIds = new Set<string>();
  input.instruments.forEach((instrument) => {
    if (!stationIdToCode.has(instrument.stationId)) orphanStationIds.add(instrument.stationId);
  });

  const allCodes = new Set<string>([...centerByCode.keys(), ...metrologyByCode.keys()]);
  // 上一轮存在、本轮两边都没数据的码不再出现（自然消失）。
  const rows: Reconciliation[] = [];

  allCodes.forEach((code) => {
    const station = centerByCode.get(code) ?? null;
    const bucket = metrologyByCode.get(code) ?? { instruments: [], calibrations: [] };
    const stationSuspensions = input.suspensions.filter((s) => s.stationCode === code);
    const previousRow = previousMap.get(code);

    const sortedCalibrations = [...bucket.calibrations].sort((a, b) => b.date.localeCompare(a.date));
    const latestDate = sortedCalibrations[0]?.date ?? '';
    const verdictLabel = worstVerdictLabel(bucket.calibrations);

    let status: ReconcileStatus;
    let issue = '';

    if (!station) {
      status = 'orphan';
      issue = '计量侧有仪器/标定，但台网中心查无此台站码，需中心补登台站后重试对账';
    } else if (bucket.instruments.length === 0) {
      status = 'station_only';
      issue = '中心已建台站，计量侧暂无仪器，等待计量站建档标定';
    } else if (station.runState === '停测' && stationSuspensions.length === 0) {
      status = 'suspension_missing';
      issue = '台站处于停测但中心尚未登记停测起止，计量侧已挂起暂不计超期';
    } else {
      status = 'matched';
    }

    // 计量站认过的结论不回退：上一轮 matched 且本轮仍可匹配（台站与仪器都在），
    // 保留已认结论与原对账时间；仅刷新计数。
    const keepAcknowledged =
      previousRow?.status === 'matched' && station !== null && bucket.instruments.length > 0;

    if (keepAcknowledged && previousRow) {
      rows.push({
        ...previousRow,
        arrayName: station ? arrayNameOf(station.arrayId) : previousRow.arrayName,
        instrumentCount: bucket.instruments.length,
        calibrationCount: bucket.calibrations.length,
        latestCalibrationDate: latestDate || previousRow.latestCalibrationDate,
        suspensionCount: stationSuspensions.length,
        attempts: previousRow.attempts,
        updatedAt: now,
      });
      return;
    }

    rows.push({
      id: `rec_${code}`,
      stationCode: code,
      status,
      centerStationId: station?.id ?? '',
      arrayName: station ? arrayNameOf(station.arrayId) : '中心查无台阵',
      instrumentCount: bucket.instruments.length,
      calibrationCount: bucket.calibrations.length,
      latestCalibrationDate: latestDate,
      acknowledgedVerdict: status === 'matched' ? verdictLabel : previousRow?.acknowledgedVerdict ?? '',
      suspensionCount: stationSuspensions.length,
      issue,
      attempts: previousRow ? previousRow.attempts : 0,
      reconciledAt: now,
      createdAt: previousRow?.createdAt ?? now,
      updatedAt: now,
    });
  });

  // 孤立仪器（台站已删但仪器残留）无法挂台站码，单列成 orphan，用占位码提示
  orphanStationIds.forEach((stationId) => {
    const orphanInstruments = input.instruments.filter((instrument) => instrument.stationId === stationId);
    const orphanCalibs = orphanInstruments.flatMap(
      (instrument) => calibrationsByInstrument.get(instrument.id) ?? []
    );
    const code = `（缺台站档案：${stationId}）`;
    rows.push({
      id: `rec_orphan_${stationId}`,
      stationCode: code,
      status: 'orphan',
      centerStationId: '',
      arrayName: '中心查无台阵',
      instrumentCount: orphanInstruments.length,
      calibrationCount: orphanCalibs.length,
      latestCalibrationDate: [...orphanCalibs].sort((a, b) => b.date.localeCompare(a.date))[0]?.date ?? '',
      acknowledgedVerdict: '',
      suspensionCount: 0,
      issue: '仪器挂在已删除的台站 id 下，台网中心需补登台站并重新绑定后重试',
      attempts: 0,
      reconciledAt: now,
      createdAt: now,
      updatedAt: now,
    });
  });

  rows.sort((a, b) => a.stationCode.localeCompare(b.stationCode, 'zh-Hans-CN'));

  return {
    rows,
    matched: rows.filter((r) => r.status === 'matched').length,
    stationOnly: rows.filter((r) => r.status === 'station_only').length,
    suspensionMissing: rows.filter((r) => r.status === 'suspension_missing').length,
    orphan: rows.filter((r) => r.status === 'orphan').length,
    unresolvedStationCodes: [],
    reconciledAt: now,
  };
}

/** 中心侧重试：仅对失败/挂起台站重试，matched 行（已认结论）原样保留。 */
export function retryReconciliation(input: ReconcileInput): ReconcileReport {
  const report = reconcileSides(input);
  // reconcileSides 已通过 previous 保住 matched 行；这里累加非 matched 台站的尝试次数。
  const previousMap = new Map((input.previous ?? []).map((row) => [row.stationCode, row]));
  report.rows.forEach((row) => {
    if (row.status !== 'matched') {
      row.attempts = (previousMap.get(row.stationCode)?.attempts ?? 0) + 1;
    }
  });
  return report;
}

/**
 * 旧数据升级：只有停测状态、没有停测时段时，按最近一次标定日期补停测时段。
 * 规则：停测开始日取该台站最近一次标定日期（复测前最后一次在册标定），resumeDate 留空（仍停测）。
 * 若该台站连一次标定都没有，则补不出，台站码进 unresolved 单列。
 */
export function backfillSuspensions(params: {
  stations: SeisStation[];
  instruments: Instrument[];
  calibrations: Calibration[];
  now: number;
}): { suspensions: Suspension[]; unresolvedStationCodes: string[] } {
  const { stations, instruments, calibrations, now } = params;
  const stationIds = new Set(stations.map((s) => s.id));
  const latestByStation = new Map<string, string>();

  instruments.forEach((instrument) => {
    if (!stationIds.has(instrument.stationId)) return;
    const own = calibrations
      .filter((calibration) => calibration.instrumentId === instrument.id)
      .map((calibration) => calibration.date)
      .sort((a, b) => b.localeCompare(a));
    const latest = own[0];
    if (!latest) return;
    const prev = latestByStation.get(instrument.stationId);
    if (!prev || latest.localeCompare(prev) > 0) latestByStation.set(instrument.stationId, latest);
  });

  const suspensions: Suspension[] = [];
  const unresolvedStationCodes: string[] = [];

  stations
    .filter((station) => station.runState === '停测')
    .forEach((station) => {
      const latestDate = latestByStation.get(station.id);
      if (!latestDate) {
        unresolvedStationCodes.push(station.code);
        return;
      }
      suspensions.push({
        id: `sus_backfill_${station.id}`,
        stationCode: station.code,
        suspendDate: latestDate,
        resumeDate: '',
        reason: '旧数据升级：按最近一次标定日期补登停测时段',
        operator: '系统迁移',
        remark: '升级前仅有停测状态，起止待台网中心核实补全',
        createdAt: now,
        updatedAt: now,
      });
    });

  return { suspensions, unresolvedStationCodes };
}
