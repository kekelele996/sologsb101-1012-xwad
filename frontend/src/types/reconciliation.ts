/**
 * 台站码对账台账（台网中心 ↔ 计量站）。
 *
 * 两边各管各的：
 * - 台网中心管台站档案与停测起止；
 * - 计量站管标定记录、灵敏度与响应结论。
 * 双方只按「台站码」对账，不直接读写对方表。
 *
 * 对账失败后由台网中心侧重试；计量站已经认过（matched）的结论不回退：
 * 重试只重算失败/挂起的台站，matched 台站保持原状。
 */

/** 对账结果状态 */
export type ReconcileStatus =
  | 'matched' // 对账一致：中心台站与计量侧仪器/标定按台站码对上
  | 'station_only' // 中心有台站、计量侧无任何仪器标定（新台站，等待计量建档）
  | 'orphan' // 计量侧有仪器/标定，但中心查无此台站码（重试责任在中心）
  | 'suspension_missing'; // 台站处于停测，但中心尚未登记停测时段：计量侧先挂起，暂不算超期

export const RECONCILE_STATUSES: ReconcileStatus[] = [
  'matched',
  'station_only',
  'suspension_missing',
  'orphan',
];

/** 各状态的中文文案与色调（供徽标/标签使用） */
export const RECONCILE_STATUS_META: Record<
  ReconcileStatus,
  { label: string; tone: 'success' | 'info' | 'warning' | 'danger'; hint: string }
> = {
  matched: { label: '已对账', tone: 'success', hint: '中心台站与计量侧标定按台站码一致' },
  station_only: {
    label: '待计量建档',
    tone: 'info',
    hint: '中心已建台站，计量侧暂无仪器/标定，等待计量站建档',
  },
  suspension_missing: {
    label: '停测时段待登记',
    tone: 'warning',
    hint: '台站处于停测但中心未登记停测起止，计量侧已挂起，暂不计算超期',
  },
  orphan: {
    label: '台站码缺失',
    tone: 'danger',
    hint: '计量侧存在该台站码的仪器/标定，但台网中心查无此台站；由中心补登后重试对账',
  },
};

/** 对账台账：每个台站码一条（计量侧视角 + 中心核对结果） */
export interface Reconciliation {
  id: string;
  /** 对账键：台站码 */
  stationCode: string;
  /** 最近一次对账结果 */
  status: ReconcileStatus;
  /** 中心侧台站 id（查无台站码时为空） */
  centerStationId: string;
  /** 中心侧台站名（取台站码，保留所属台阵名便于定位） */
  arrayName: string;
  /** 计量侧该台站码下的仪器台数 */
  instrumentCount: number;
  /** 计量侧该台站码下的标定条数 */
  calibrationCount: number;
  /** 计量侧最近一次标定日期 */
  latestCalibrationDate: string;
  /** 计量侧已认过的响应结论摘要（如：合格 / 不合格），matched 后不回退 */
  acknowledgedVerdict: string;
  /** 中心登记的停测时段数 */
  suspensionCount: number;
  /** 失败/挂起原因（人话说明） */
  issue: string;
  /** 已重试次数（中心侧重试累加） */
  attempts: number;
  /** 最近一次对账时间戳 */
  reconciledAt: number;
  createdAt: number;
  updatedAt: number;
}

/** 一次全量对账的汇总结果 */
export interface ReconcileReport {
  /** 按台站码产出的台账行 */
  rows: Reconciliation[];
  matched: number;
  stationOnly: number;
  suspensionMissing: number;
  orphan: number;
  /** 旧数据升级时补不出停测时段、需单列人工处理的台站码 */
  unresolvedStationCodes: string[];
  reconciledAt: number;
}
