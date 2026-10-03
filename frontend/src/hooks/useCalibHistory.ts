/**
 * useCalibHistory：按仪器聚合历次标定、算灵敏度变化量与待标定天数。
 * 被标定记录台（/calibrations）与更换提醒页（/replacements）消费。
 *
 * 两侧分账后，到期测算口径（见 types/suspension.ts.evaluateDue）：
 * - 台网中心登记的停测自然日从标定周期扣减；
 * - 复测后到期的照旧排标定、照算超期；
 * - 停测期间扣减后够不到期的不进更换提醒；
 * - 中心只标停测状态、还没登记时段的，计量站先挂起，不算超期。
 */
import { useCallback, useMemo } from 'react';
import { useSelector } from 'react-redux';
import { selectArrays, selectStations } from '@/stores/arraySlice';
import { selectInstruments } from '@/stores/instrumentSlice';
import { selectCalibrations } from '@/stores/calibrationSlice';
import { selectWindowsByStationCode } from '@/stores/suspensionSlice';
import { calibrateDueText, sensitivityDelta, type SensitivityDelta } from '@/types/calibration';
import { CALIBRATION_CYCLE_DAYS } from '@/types/instrument';
import { evaluateDue, dueStateText, type DueEvaluation } from '@/types/suspension';
import type { Calibration, ResponseVerdict } from '@/types/calibration';
import type { Instrument } from '@/types/instrument';

/** 单台仪器的标定历史聚合 */
export interface InstrumentCalibHistory {
  instrument: Instrument;
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
  /** 距下次标定天数（负数为已超期）；停测挂起时为 null */
  dueInDays: number | null;
  /** 到期测算（含停测扣减 / 挂起状态） */
  due: DueEvaluation;
  /** 是否硬超期（仅 overdue 进更换提醒；停测挂起 / 停测中未到期不算） */
  overdue: boolean;
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
  /** 进入更换提醒的仪器：硬超期或仪器被置为待标定 */
  overdueHistories: InstrumentCalibHistory[];
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
  const windowsByCode = useSelector(selectWindowsByStationCode);

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
        const stationCode = station?.code ?? '';
        const due = evaluateDue({
          baseDate: latest ? latest.date : instrument.installDate,
          cycleDays: CALIBRATION_CYCLE_DAYS,
          windows: stationCode ? windowsByCode[stationCode] ?? [] : [],
          stationState: station?.obsStatus ?? '运行',
        });
        const overdue = due.state === 'overdue';
        const worstVerdict = rows.reduce<ResponseVerdict>((worst, row) => {
          return VERDICT_ORDER[row.responseVerdict] > VERDICT_ORDER[worst] ? row.responseVerdict : worst;
        }, '合格');
        return {
          instrument,
          stationCode: station ? station.code : '未知台站',
          arrayId: array?.id ?? station?.arrayId ?? '',
          arrayName: array?.name ?? '未知台阵',
          calibrations: rows,
          latest,
          delta,
          count: rows.length,
          dueInDays: due.dueInDays,
          due,
          overdue,
          pending: instrument.state === '待标定' || overdue,
          worstVerdict,
          trend: [...rows]
            .reverse()
            .map((row) => ({ date: row.date, sensitivity: row.sensitivity, selfNoise: row.selfNoise })),
        };
      })
      .sort((a, b) => {
        // 超期的排最前，挂起 / 停测中的沉底
        const rank = (history: InstrumentCalibHistory): number =>
          history.due.dueInDays === null ? Number.MAX_SAFE_INTEGER : history.due.dueInDays;
        return rank(a) - rank(b);
      });
  }, [arrays, calibrations, instruments, stations, windowsByCode]);

  const historyOf = useCallback(
    (instrumentId: string): InstrumentCalibHistory | null =>
      histories.find((history) => history.instrument.id === instrumentId) ?? null,
    [histories]
  );

  const overdueHistories = useMemo(
    () => histories.filter((history) => history.overdue || history.instrument.state === '待标定'),
    [histories]
  );

  const trendOf = useCallback(
    (instrumentId: string): Array<{ date: string; sensitivity: number; selfNoise: number }> =>
      histories.find((history) => history.instrument.id === instrumentId)?.trend ?? [],
    [histories]
  );

  return { histories, historyOf, overdueHistories, trendOf };
}

/** 标定周期说明文案，供页面提示 */
export const CALIBRATION_CYCLE_TEXT = `标定周期 ${CALIBRATION_CYCLE_DAYS} 天（约 1 年），停测自然日从周期中扣减；停测中未到期与时段待登记的台站不进更换提醒`;

/** 待标定天数文案（走停测扣减口径） */
export function dueText(history: InstrumentCalibHistory): string {
  return history.due.dueInDays === null ? dueStateText(history.due) : calibrateDueText(history.due.dueInDays);
}
