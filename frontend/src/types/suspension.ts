/**
 * 台站停测时段（台网中心侧台账）。
 * 台网中心管台站与停测起止；计量站不管停测，只在推算标定周期时按台站码引用这些时段扣减天数。
 */

/** 台站运行状态（台网中心登记） */
export type StationRunState = '运行' | '停测';

export const STATION_RUN_STATES: StationRunState[] = ['运行', '停测'];

/**
 * 停测时段：一条记录表示台站一次施工停测。
 * - resumeDate 为空表示仍在停测中（复测尚未完成）。
 * - 起止均为自然日（YYYY-MM-DD），闭区间，按天扣减标定周期。
 */
export interface Suspension {
  id: string;
  /** 台站码（对账键，冗余自台站档案，台站改码时随中心数据一并维护） */
  stationCode: string;
  /** 停测开始日期（YYYY-MM-DD） */
  suspendDate: string;
  /** 复测/恢复日期；空串表示停测中尚未复测 */
  resumeDate: string;
  /** 停测原因（如：台站施工改造） */
  reason: string;
  /** 登记人（台网中心） */
  operator: string;
  /** 备注 */
  remark: string;
  createdAt: number;
  updatedAt: number;
}

/** 停测时段登记草稿 */
export interface SuspensionDraft {
  stationCode: string;
  suspendDate: string;
  resumeDate: string;
  reason: string;
  operator: string;
  remark: string;
}

export function createEmptySuspensionDraft(stationCode = ''): SuspensionDraft {
  return {
    stationCode,
    suspendDate: new Date().toISOString().slice(0, 10),
    resumeDate: '',
    reason: '台站施工停测',
    operator: '',
    remark: '',
  };
}

/** 停测时段是否仍在进行（未填复测日期） */
export function isOngoing(suspension: Pick<Suspension, 'resumeDate'>): boolean {
  return !suspension.resumeDate;
}

/**
 * 计算停测时段与区间 [fromDate, toDate]（均为 YYYY-MM-DD，闭区间）重叠的自然日天数。
 * 停测按半开区间计：[suspendDate, resumeDate)，复测恢复当天仪器已恢复观测，不计停测；
 * resumeDate 为空（仍停测）时计到 toDate（含当天）。起止非法或无重叠返回 0。
 */
export function overlapDays(
  suspension: Pick<Suspension, 'suspendDate' | 'resumeDate'>,
  fromDate: string,
  toDate: string
): number {
  const from = Date.parse(`${fromDate}T00:00:00`);
  const to = Date.parse(`${toDate}T00:00:00`);
  const start = Date.parse(`${suspension.suspendDate}T00:00:00`);
  if (!Number.isFinite(from) || !Number.isFinite(to) || !Number.isFinite(start)) return 0;
  // 恢复日当天恢复观测：停测区间右开，结束点取 resumeDate 当天 00:00（不含）
  const end = suspension.resumeDate
    ? Date.parse(`${suspension.resumeDate}T00:00:00`)
    : to + 86400000;
  if (!Number.isFinite(end)) return 0;
  const overlapStart = Math.max(from, start);
  const overlapEnd = Math.min(to + 86400000, Math.max(start, end));
  if (overlapEnd <= overlapStart) return 0;
  return Math.round((overlapEnd - overlapStart) / 86400000);
}

/**
 * 合并多个停测时段后，统计区间 [fromDate, toDate]（闭区间）内的停测总天数（去重，避免重叠时段双算）。
 * 停测区间半开 [suspendDate, resumeDate)；仍在停测的收口到 toDate 当天。
 */
export function suspendedDaysWithin(
  suspensions: Array<Pick<Suspension, 'suspendDate' | 'resumeDate'>>,
  fromDate: string,
  toDate: string
): number {
  const from = Date.parse(`${fromDate}T00:00:00`);
  const to = Date.parse(`${toDate}T00:00:00`);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return 0;
  const windowEnd = to + 86400000;
  const intervals = suspensions
    .map((s) => {
      const start = Date.parse(`${s.suspendDate}T00:00:00`);
      if (!Number.isFinite(start)) return null;
      const endMs = s.resumeDate ? Date.parse(`${s.resumeDate}T00:00:00`) : windowEnd;
      if (!Number.isFinite(endMs)) return null;
      return { start: Math.max(from, start), end: Math.min(windowEnd, Math.max(start, endMs)) };
    })
    .filter((iv): iv is { start: number; end: number } => iv !== null && iv.end > iv.start)
    .sort((a, b) => a.start - b.start);

  let total = 0;
  let cursor = from;
  for (const iv of intervals) {
    const segStart = Math.max(iv.start, cursor);
    if (iv.end > segStart) {
      total += Math.round((iv.end - segStart) / 86400000);
      cursor = iv.end;
    }
  }
  return total;
}
