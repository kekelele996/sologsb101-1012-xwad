/**
 * 标定周期推算引擎（计量站侧）。
 *
 * 规则：
 * 1. 标定周期按自然日计，但台站经台网中心登记的停测天数要从周期里扣掉（周期时钟在停测期间暂停）。
 * 2. 台站处于停测、且中心尚未登记停测时段时，计量侧「先挂着」，状态记为 held，不计算超期。
 * 3. 复测恢复后，若扣减掉停测天数仍已到期，照常排出下次标定（due / overdue）。
 * 4. 停测期间按有效周期够不到期的（仍在未来），不进更换提醒（remaining，不算 overdue）。
 *
 * 计量站不直接读写台站/停测表：调用方把「是否停测」「停测时段」按台站码查好后传入。
 */
import { CALIBRATION_CYCLE_DAYS } from '@/types/instrument';
import {
  suspendedDaysWithin,
  type Suspension,
} from '@/types/suspension';

const DAY_MS = 86400000;

/** 周期推算状态 */
export type DueStatus =
  | 'overdue' // 已超期（扣减停测后仍到期，复测后照常排标定）
  | 'due' // 今日到期
  | 'remaining' // 尚有剩余天数（停测期间够不到期的也归此，不进更换提醒）
  | 'held'; // 挂起：停测但中心未登记停测时段，暂不计算超期

export interface DueResult {
  status: DueStatus;
  /** 距到期天数（扣减停测后；正数剩余、负数超期、0 今日到期）；held 时为 null */
  dueInDays: number | null;
  /** 本次推算从周期中扣掉的停测天数 */
  suspendedDays: number;
  /** 有效到期日（YYYY-MM-DD，已按停测顺延）；held 时为 null */
  effectiveDueDate: string | null;
  /** 是否应进入更换提醒（只有真正超期才进） */
  remind: boolean;
  /** 人话说明 */
  reason: string;
}

function toDate(yyyyMmDd: string): Date {
  return new Date(`${yyyyMmDd}T00:00:00`);
}

function toDayString(time: number): string {
  const d = new Date(time);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export interface ScheduleInput {
  /** 最近一次标定日期；无标定则传安装日期 */
  baseDate: string;
  /** 该台站当前是否处于停测（台网中心登记的运行状态） */
  stationSuspended: boolean;
  /** 台网中心已登记的停测时段（按台站码） */
  suspensions: Suspension[];
  /** 评定基准日（默认今天，YYYY-MM-DD），主要为测试与可重放而保留 */
  today?: string;
}

/**
 * 推算单台仪器的标定到期情况（停测天数从周期中扣除）。
 */
export function computeDue(input: ScheduleInput): DueResult {
  const todayStr = input.today ?? new Date().toISOString().slice(0, 10);
  const today = toDate(todayStr).getTime();
  const base = toDate(input.baseDate).getTime();

  if (!Number.isFinite(base)) {
    // 基准日期非法时无法推算，保守挂起而不是误报超期
    return {
      status: 'held',
      dueInDays: null,
      suspendedDays: 0,
      effectiveDueDate: null,
      remind: false,
      reason: '基准标定日期缺失，暂挂起',
    };
  }

  // 台站停测中但中心没登记任何停测时段：先挂着，别先算超期
  const hasRegisteredSuspension = input.suspensions.length > 0;
  if (input.stationSuspended && !hasRegisteredSuspension) {
    return {
      status: 'held',
      dueInDays: null,
      suspendedDays: 0,
      effectiveDueDate: null,
      remind: false,
      reason: '台网中心尚未登记停测时段，计量侧暂挂起、不计超期',
    };
  }

  // 从基准日到今天，落在周期计时窗口内的停测自然日（已去重）
  const elapsedDays = Math.max(0, Math.round((today - base) / DAY_MS));
  const lastDay = elapsedDays === 0 ? todayStr : toDayString(base + elapsedDays * DAY_MS);
  const suspendedDays = suspendedDaysWithin(input.suspensions, input.baseDate, lastDay);

  // 有效到期 = 基准 + 周期 + 停测顺延
  const effectiveDue = base + CALIBRATION_CYCLE_DAYS * DAY_MS + suspendedDays * DAY_MS;
  const effectiveDueDate = toDayString(effectiveDue);
  const dueInDays = Math.round((effectiveDue - today) / DAY_MS);

  let status: DueStatus;
  let remind = false;
  let reason: string;
  if (dueInDays < 0) {
    status = 'overdue';
    remind = true;
    reason =
      suspendedDays > 0
        ? `已扣减停测 ${suspendedDays} 天，仍超期 ${Math.abs(dueInDays)} 天，复测后照常排标定`
        : `已超期 ${Math.abs(dueInDays)} 天`;
  } else if (dueInDays === 0) {
    status = 'due';
    reason = suspendedDays > 0 ? `今日到期（已扣减停测 ${suspendedDays} 天）` : '今日到期';
  } else {
    status = 'remaining';
    reason =
      suspendedDays > 0
        ? `停测 ${suspendedDays} 天已从周期扣除，剩余 ${dueInDays} 天，停测期间不提醒`
        : `剩余 ${dueInDays} 天`;
  }

  return { status, dueInDays, suspendedDays, effectiveDueDate, remind, reason };
}

/** 到期状态中文文案 */
export function dueStatusText(result: DueResult): string {
  switch (result.status) {
    case 'overdue':
      return `超期 ${Math.abs(result.dueInDays ?? 0)} 天`;
    case 'due':
      return '今日到期';
    case 'remaining':
      return `剩余 ${result.dueInDays ?? 0} 天`;
    case 'held':
      return '停测挂起';
  }
}
