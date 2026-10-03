/**
 * useCalibHistory：按仪器聚合历次标定、算灵敏度变化量与待标定天数。
 * 被标定记录台（/calibrations）与更换提醒页（/replacements）消费。
 *
 * 计量侧周期推算（utils/schedule.ts）：
 * - 台站经台网中心登记的停测天数从标定周期里扣除；
 * - 停测中但中心未登记停测时段的台站，仪器先挂起（held），不算超期、不进更换提醒；
 * - 复测后扣减停测仍到期的照常排标定（overdue/due）。
 */
import { useCallback, useMemo } from 'react';
import { useSelector } from 'react-redux';
import { selectArrays, selectStations } from '@/stores/arraySlice';
import { selectInstruments } from '@/stores/instrumentSlice';
import { selectCalibrations } from '@/stores/calibrationSlice';
import { selectSuspensionsByCode } from '@/stores/centerSlice';
import { sensitivityDelta, type SensitivityDelta } from '@/types/calibration';
import type { Calibration, ResponseVerdict } from '@/types/calibration';
import type { Instrument } from '@/types/instrument';
import { computeDue, dueStatusText, type DueResult } from '@/utils/schedule';

/** 单台仪器的标定历史聚合 */
export interface InstrumentCalibHistory {
  instrument: Instrument;
  stationId: string;
  stationCode: string;
  arrayId: string;
  arrayName: string;
  /** 历次标定（按日期降序） */
  calibrations: Calibration[];
  /** 最近一次标定 */
  latest: Calibration | null;
  /** 最近一次灵敏度相对上一次的变化 */
  delta: SensitivityDelta;
  /** 标定次数 */
  count: number;
  /** 距下次标定天数（扣减停测后；负数为已超期；held 为 null） */
  dueInDays: number | null;
  /** 周期推算完整结果（停测扣减 / 挂起 / 提醒） */
  due: DueResult;
  /** 是否超期未标定（仅真正超期；挂起不算） */
  overdue: boolean;
  /** 是否挂起（停测但中心未登记停测时段） */
  held: boolean;
  /** 是否处于待标定状态 */
  pending: boolean;
  /** 历次结论中最差的一次 */
  worstVerdict: ResponseVerdict;
  /** 灵敏度序列（由旧到新），供趋势展示 */
  trend: Array<{ date: string; sensitivity: number; selfNoise: number }>;
}

export interface UseCalibHistoryResult {
  histories: InstrumentCalibHistory[];
  historyOf: (instrumentId: string) => InstrumentCalibHistory | null;
  /** 进入更换提醒的仪器：真正超期，且非挂起（停测期间够不到期 / 未登记时段的不进） */
  overdueHistories: InstrumentCalibHistory[];
  /** 挂起待中心登记停测时段的仪器 */
  heldHistories: InstrumentCalibHistory[];
  /** 灵敏度趋势：返回指定仪器的序列 */
  trendOf: (instrumentId: string) => Array<{ date: string; sensitivity: number; selfNoise: number }>;
}

const VERDICT_ORDER: Record<ResponseVerdict, number> = { 合格: 0, 待判定: 1, 不合格: 2 };

/**
 * 组合式 Hook：基于 Redux 中的台阵 / 台站 / 仪器 / 标定 / 停测数据派生标定历史与超期提醒。
 */
export function useCalibHistory(): UseCalibHistoryResult {
  const arrays = useSelector(selectArrays);
  const stations = useSelector(selectStations);
  const instruments = useSelector(selectInstruments);
  const calibrations = useSelector(selectCalibrations);
  const suspensionsByCode = useSelector(selectSuspensionsByCode);

  const histories = useMemo<InstrumentCalibHistory[]>(() => {
    return instruments
      .map((instrument) => {
        const station = stations.find((item) => item.id === instrument.stationId);
        const array = station ? arrays.find((item) => item.id === station.arrayId) : undefined;
        const rows = calibrations
          .filter((calibration) => calibration.instrumentId === instrument.id)
          .sort((a, b) => b.date.localeCompare(a.date));
        const latest = rows.length > 0 ? rows[0] : null;
        const previous = rows.length > 1 ? rows[1] : null;
        const delta = sensitivityDelta(latest?.sensitivity ?? 0, previous ? previous.sensitivity : null);

        const stationCode = station?.code ?? '未知台站';
        const stationSuspended = station?.runState === '停测';
        const stationSuspensions = station ? suspensionsByCode[station.code] ?? [] : [];
        const baseDate = latest ? latest.date : instrument.installDate;
        const due = computeDue({
          baseDate,
          stationSuspended,
          suspensions: stationSuspensions,
        });

        const worstVerdict = rows.reduce<ResponseVerdict>((worst, row) => {
          return VERDICT_ORDER[row.responseVerdict] > VERDICT_ORDER[worst] ? row.responseVerdict : worst;
        }, '合格');
        const overdue = due.status === 'overdue';
        const held = due.status === 'held';
        return {
          instrument,
          stationId: instrument.stationId,
          stationCode,
          arrayId: array?.id ?? station?.arrayId ?? '',
          arrayName: array?.name ?? '未知台阵',
          calibrations: rows,
          latest,
          delta,
          count: rows.length,
          dueInDays: due.dueInDays,
          due,
          overdue,
          held,
          pending: (instrument.state === '待标定' && !held) || overdue,
          worstVerdict,
          trend: [...rows]
            .reverse()
            .map((row) => ({ date: row.date, sensitivity: row.sensitivity, selfNoise: row.selfNoise })),
        };
      })
      .sort((a, b) => (a.dueInDays ?? Number.MAX_SAFE_INTEGER) - (b.dueInDays ?? Number.MAX_SAFE_INTEGER));
  }, [arrays, calibrations, instruments, stations, suspensionsByCode]);

  const historyOf = useCallback(
    (instrumentId: string): InstrumentCalibHistory | null =>
      histories.find((history) => history.instrument.id === instrumentId) ?? null,
    [histories]
  );

  const overdueHistories = useMemo(
    () => histories.filter((history) => history.overdue),
    [histories]
  );

  const heldHistories = useMemo(() => histories.filter((history) => history.held), [histories]);

  const trendOf = useCallback(
    (instrumentId: string): Array<{ date: string; sensitivity: number; selfNoise: number }> =>
      histories.find((history) => history.instrument.id === instrumentId)?.trend ?? [],
    [histories]
  );

  return { histories, historyOf, overdueHistories, heldHistories, trendOf };
}

/** 标定周期说明文案，供页面提示 */
export const CALIBRATION_CYCLE_TEXT = `标定周期 365 天（约 1 年），台站停测天数从周期中扣除；停测期间不提醒、复测后照常排标定`;

/** 待标定天数文案 */
export function dueText(history: InstrumentCalibHistory): string {
  return dueStatusText(history.due);
}
