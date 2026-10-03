/**
 * 台网中心 slice：管台站停测时段与「台站码对账台账」。
 * - 停测起止由台网中心登记（计量站不写这张表，只在推算周期时按台站码引用）；
 * - 对账按台站码进行；对账失败后由中心侧重试，计量站认过（matched）的结论不回退。
 */
import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { db, createId, watchTable, readUnresolvedSuspensionCodes } from '@/utils/db';
import type { Suspension } from '@/types/suspension';
import {
  type Reconciliation,
  type ReconcileReport,
} from '@/types/reconciliation';
import { reconcileSides, retryReconciliation } from '@/utils/reconcile';
import type { RootState } from '@/stores/store';

type WithCenter = RootState;

export interface CenterSliceState {
  suspensions: Suspension[];
  reconciliations: Reconciliation[];
  ready: boolean;
  /** 最近一次对账报告（含汇总计数与升级遗留台站码） */
  lastReport: ReconcileReport | null;
  lastReceipt: string;
}

const initialState: CenterSliceState = {
  suspensions: [],
  reconciliations: [],
  ready: false,
  lastReport: null,
  lastReceipt: '',
};

/* ------------------------------ 停测时段 ------------------------------ */

export const createSuspension = createAsyncThunk(
  'center/createSuspension',
  async (payload: Omit<Suspension, 'id' | 'createdAt' | 'updatedAt'>) => {
    const now = Date.now();
    const row: Suspension = { ...payload, id: createId('sus'), createdAt: now, updatedAt: now };
    await db.suspensions.put(row);
    return row;
  }
);

export const updateSuspension = createAsyncThunk(
  'center/updateSuspension',
  async (payload: { id: string; patch: Partial<Suspension> }) => {
    await db.suspensions.update(payload.id, { ...payload.patch, updatedAt: Date.now() } as never);
    return payload;
  }
);

export const removeSuspension = createAsyncThunk(
  'center/removeSuspension',
  async (id: string) => {
    await db.suspensions.delete(id);
    return id;
  }
);

/* ------------------------------ 对账（中心侧重试） ------------------------------ */

async function readReconcileTables() {
  const [arrays, stations, instruments, calibrations, suspensions, previous] = await Promise.all([
    db.arrays.toArray(),
    db.stations.toArray(),
    db.instruments.toArray(),
    db.calibrations.toArray(),
    db.suspensions.toArray(),
    db.reconciliations.toArray(),
  ]);
  return { arrays, stations, instruments, calibrations, suspensions, previous };
}

async function persistReport(report: ReconcileReport): Promise<void> {
  await db.reconciliations.bulkPut(report.rows);
}

/** 全量对账（幂等：matched 行保留计量站已认结论） */
export const runReconciliation = createAsyncThunk(
  'center/runReconciliation',
  async (_, { getState }) => {
    const tables = await readReconcileTables();
    const state = getState() as RootState;
    const unresolved =
      state.center.lastReport?.unresolvedStationCodes ?? readUnresolvedSuspensionCodes();
    const report = reconcileSides(tables);
    report.unresolvedStationCodes = unresolved;
    await persistReport(report);
    return report;
  }
);

/** 中心侧重试：仅推进失败/挂起台站，matched 行与已认结论原样保留 */
export const retryReconcile = createAsyncThunk('center/retryReconcile', async () => {
  const tables = await readReconcileTables();
  const report = retryReconciliation(tables);
  await persistReport(report);
  return report;
});

const centerSlice = createSlice({
  name: 'center',
  initialState,
  reducers: {
    setSuspensions(state, action: PayloadAction<Suspension[]>) {
      state.suspensions = action.payload;
    },
    setReconciliations(state, action: PayloadAction<Reconciliation[]>) {
      state.reconciliations = action.payload;
      state.ready = true;
    },
    setReport(state, action: PayloadAction<ReconcileReport | null>) {
      state.lastReport = action.payload;
    },
    setUnresolvedCodes(state, action: PayloadAction<string[]>) {
      if (state.lastReport) {
        state.lastReport = { ...state.lastReport, unresolvedStationCodes: action.payload };
      }
    },
    setCenterReceipt(state, action: PayloadAction<string>) {
      state.lastReceipt = action.payload;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(runReconciliation.fulfilled, (state, action) => {
        state.lastReport = action.payload;
        state.lastReceipt = `对账完成：一致 ${action.payload.matched} 个台站码`;
      })
      .addCase(retryReconcile.fulfilled, (state, action) => {
        state.lastReport = action.payload;
        state.lastReceipt = '中心侧已重试对账，计量站认过的结论保持不变';
      });
  },
});

export const {
  setSuspensions,
  setReconciliations,
  setReport,
  setUnresolvedCodes,
  setCenterReceipt,
} = centerSlice.actions;

let started = false;

/** 启动停测时段 / 对账台账实时订阅（幂等） */
export function startCenterSubscription(dispatch: (action: unknown) => void): void {
  if (started) return;
  started = true;
  watchTable<Suspension>(() => db.suspensions).subscribe((rows) => {
    dispatch(setSuspensions(rows));
  });
  watchTable<Reconciliation>(() => db.reconciliations).subscribe((rows) => {
    dispatch(setReconciliations(rows));
  });
}

/* ------------------------------ Selector ------------------------------ */

export const selectCenterState = (state: WithCenter): CenterSliceState => state.center;
export const selectSuspensions = (state: WithCenter): Suspension[] => state.center.suspensions;
export const selectReconciliations = (state: WithCenter): Reconciliation[] =>
  state.center.reconciliations;
export const selectReconcileReport = (state: WithCenter): ReconcileReport | null =>
  state.center.lastReport;

/** 台站码 → 停测时段（升序） */
export const selectSuspensionsByCode = (
  state: WithCenter
): Record<string, Suspension[]> => {
  const map: Record<string, Suspension[]> = {};
  state.center.suspensions.forEach((row) => {
    const list = map[row.stationCode] ?? [];
    list.push(row);
    map[row.stationCode] = list;
  });
  Object.values(map).forEach((list) =>
    list.sort((a, b) => a.suspendDate.localeCompare(b.suspendDate))
  );
  return map;
};

export default centerSlice.reducer;
