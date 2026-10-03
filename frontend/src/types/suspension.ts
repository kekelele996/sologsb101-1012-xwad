/**
 * 停测领域（台网中心侧台账）：
 * 台站观测状态、停测时段窗口，以及"停测天数从标定周期扣减"的到期测算。
 *
 * 职责边界：
 * - 台网中心只管台站、台站码与停测起止（本文件 + suspensionSlice）；
 * - 计量站只管标定记录、灵敏度与响应结论（calibrationSlice）；
 * - 两侧按台站码对账（见 reconcile.ts），计量站不自行推断停测时段。
 */
import type { StationObsState } from '@/types/station';

export type { StationObsState };
export { STATION_OBS_STATES } from '@/types/station';

/** 停测时段：台网中心登记的施工停测起止 */
export interface SuspensionWindow {
  id: string;
  /** 台站码（与计量站侧对账的唯一键，不存 stationId，避免越权改台站档案） */
  stationCode: string;
  /** 停测起始日（YYYY-MM-DD，含当日） */
  startDate: string;
  /** 复测 / 恢复日（YYYY-MM-DD，含当日）；空串表示停测中、尚未复测 */
  endDate: string;
  /** 停测原因，如基建施工 / 台址改造 */
  reason: string;
  /** 登记人（台网中心） */
  operator: string;
  /** 备注 */
  remark: string;
  /** true：由旧数据（只有停测状态）升级时按最近标定日期补推 */
  inferred?: boolean;
  createdAt: number;
  updatedAt: number;
}

/** 到期状态 */
export type DueState =
  | 'normal' // 正常在周期内
  | 'due-today' // 今日到期
  | 'overdue' // 已超期（复测后仍未标定）
  | 'suspended-ok' // 停测中，扣减后仍够不到期，不进更换提醒
  | 'pending-period'; // 台网中心标了停测但还没登记停测时段：先挂起，不算超期

export interface DueEvaluation {
  /** 业务状态 */
  state: DueState;
  /** 相对今天的天数：正数剩余、0 今日到期、负数超期；挂起时为 null */
  dueInDays: number | null;
  /** 名义到期日（未扣停测），YYYY-MM-DD */
  nominalDueDate: string;
  /** 扣减停测天数后的实际到期日，YYYY-MM-DD；挂起时为 null */
  effectiveDueDate: string | null;
  /** 从标定周期中扣掉的停测天数（自然日） */
  deductedDays: number;
  /** 当前是否处于停测窗口内（含时段已登记的停测） */
  inSuspension: boolean;
  /** 台站观测状态是否为停测 */
  stationSuspended: boolean;
  /** 是否只标了停测状态、尚未登记停测时段（计量站先挂起） */
  awaitingPeriod: boolean;
}

const DAY_MS = 86400000;

function parseDay(value: string): number | null {
  const t = Date.parse(`${value}T00:00:00`);
  return Number.isFinite(t) ? Math.floor(t / DAY_MS) : null;
}

function toDay(dayIndex: number): string {
  const d = new Date(dayIndex * DAY_MS);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 停测窗口与 [fromDay, toDay] 区间的重叠天数（含首尾，按自然日）。
 * 未复测（endDate 为空）的窗口按到 toDay 计。
 */
export function overlapDays(
  window: Pick<SuspensionWindow, 'startDate' | 'endDate'>,
  fromDay: number,
  toDay: number
): number {
  const start = parseDay(window.startDate);
  if (start === null) return 0;
  const rawEnd = window.endDate ? parseDay(window.endDate) : toDay;
  const end = rawEnd === null ? toDay : rawEnd;
  const lo = Math.max(start, fromDay);
  const hi = Math.min(end, toDay);
  return hi >= lo ? hi - lo + 1 : 0;
}

/** 一组窗口在 [fromDay, toDay] 内的停测天数合计（重叠区间只计一次） */
export function totalSuspendedDays(
  windows: Array<Pick<SuspensionWindow, 'startDate' | 'endDate'>>,
  fromDay: number,
  toDay: number
): number {
  const segments: Array<[number, number]> = [];
  windows.forEach((window) => {
    const start = parseDay(window.startDate);
    if (start === null) return;
    const rawEnd = window.endDate ? parseDay(window.endDate) : toDay;
    const end = rawEnd === null ? toDay : rawEnd;
    const lo = Math.max(start, fromDay);
    const hi = Math.min(end, toDay);
    if (hi >= lo) segments.push([lo, hi]);
  });
  if (segments.length === 0) return 0;
  segments.sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [curLo, curHi] = segments[0];
  for (let i = 1; i < segments.length; i += 1) {
    const [lo, hi] = segments[i];
    if (lo <= curHi + 1) {
      curHi = Math.max(curHi, hi);
    } else {
      total += curHi - curLo + 1;
      curLo = lo;
      curHi = hi;
    }
  }
  total += curHi - curLo + 1;
  return total;
}

export interface EvaluateDueParams {
  /** 最近一次标定日期（无标定用安装日期），YYYY-MM-DD */
  baseDate: string;
  /** 标定周期（天） */
  cycleDays: number;
  /** 该台站名下的停测时段 */
  windows: Array<Pick<SuspensionWindow, 'startDate' | 'endDate'>>;
  /** 台网中心登记的台站观测状态 */
  stationState: StationObsState;
  /** 计算基准日（默认今天），测试可注入 */
  today?: string;
}

/**
 * 测算标定到期情况：
 * 1. 停测的自然日从标定周期中扣掉（名义到期日顺延）；
 * 2. 复测（窗口结束）后到期的，照旧排标定、照算超期；
 * 3. 停测期间扣减后够不到期的，不进更换提醒（suspended-ok）；
 * 4. 只标了停测状态、中心还没登记停测时段的，计量站先挂起（pending-period），不算超期。
 */
export function evaluateDue(params: EvaluateDueParams): DueEvaluation {
  const todayStr = params.today ?? new Date().toISOString().slice(0, 10);
  const today = parseDay(todayStr) ?? parseDay(new Date().toISOString().slice(0, 10))!;
  const base = parseDay(params.baseDate) ?? today;
  const nominalDue = base + params.cycleDays;

  const stationSuspended = params.stationState === '停测';
  // 中心标了停测却查不到任何时段：计量站先挂着，绝不先算超期
  const awaitingPeriod = stationSuspended && params.windows.length === 0;

  // 截至今天实际经历过的停测天数（落在基准日之后的部分才与本周期有关）
  const elapsedSuspended = totalSuspendedDays(params.windows, base, today);
  const effectiveDue = nominalDue + elapsedSuspended;

  // 今天是否落在某个（含未复测的）停测窗口内
  const inSuspension = params.windows.some((window) => overlapDays(window, today, today) > 0);

  const dueInDays = effectiveDue - today;
  let state: DueState;
  if (awaitingPeriod) {
    state = 'pending-period';
  } else if (inSuspension) {
    // 停测期间：扣减后仍未到期的不提醒；停测前就已到期的保持超期
    state = dueInDays > 0 ? 'suspended-ok' : dueInDays === 0 ? 'due-today' : 'overdue';
  } else if (dueInDays < 0) {
    state = 'overdue';
  } else if (dueInDays === 0) {
    state = 'due-today';
  } else {
    state = 'normal';
  }

  // 本周期内已从标定周期扣掉的停测天数（到今天为止实际经历、且落在基准日之后）
  // 展示"顺延 X 天"与 dueInDays 同源，避免两个口径
  const deductedDays = elapsedSuspended;

  return {
    state,
    dueInDays: awaitingPeriod ? null : dueInDays,
    nominalDueDate: toDay(nominalDue),
    effectiveDueDate: awaitingPeriod ? null : toDay(effectiveDue),
    deductedDays,
    inSuspension,
    stationSuspended,
    awaitingPeriod,
  };
}

/** 到期状态文案（供各页统一展示） */
export function dueStateText(evaluation: DueEvaluation): string {
  switch (evaluation.state) {
    case 'overdue':
      return `已超期 ${Math.abs(evaluation.dueInDays ?? 0)} 天`;
    case 'due-today':
      return '今日到期';
    case 'suspended-ok':
      return `停测中，顺延 ${evaluation.deductedDays} 天`;
    case 'pending-period':
      return '停测时段待中心登记，暂挂起';
    default:
      return `距下次标定 ${evaluation.dueInDays ?? 0} 天`;
  }
}

/** 是否进入更换提醒：只有"硬超期"才算；停测挂起 / 停测中未到期均不进 */
export function isOverdueForReplace(evaluation: DueEvaluation): boolean {
  return evaluation.state === 'overdue';
}
