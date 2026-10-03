/**
 * 停测 slice（台网中心侧）：
 * - 只管台站观测状态（运行 / 停测）与停测起止时段；
 * - 按台站码发起与计量站侧的对账，失败由中心侧重试；
 * - 计量站已认过的标定结论，对账重试时不回退。
 *
 * 计量站侧的标定 / 灵敏度 / 响应结论不在本 slice 出现，做到两边各管各的。
 */
import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import {
  db,
  createId,
  watchTable,
  readUnresolvedSuspensions,
  resolveUnresolvedSuspension,
  type UnresolvedSuspension,
} from '@/utils/db';
import type { StationObsState } from '@/types/station';
import type { SuspensionWindow } from '@/types/suspension';
import { reconcileLedgers, type ReconcileReport } from '@/types/reconcile';
import type { RootState } from '@/stores/store';

type WithSuspension = RootState;

export interface SuspensionSliceState {
  windows: SuspensionWindow[];
  /** 升级时补不出停测时段的台站（单列） */
  unresolved: UnresolvedSuspension[];
  /** 最近一次对账报告；null 表示从未对账 */
  report: ReconcileReport | null;
  reconciling: boolean;
  error: string | null;
  lastReceipt: string;
}

const initialState: SuspensionSliceState = {
  windows: [],
  unresolved: readUnresolvedSuspensions(),
  report: null,
  reconciling: false,
  error: null,
  lastReceipt: '',
};

/** 登记停测时段；同时把台站观测状态置为停测（同事务，中心侧自管） */
export const createSuspension = createAsyncThunk(
  'suspension/createSuspension',
  async (payload: Omit<SuspensionWindow, 'id' | 'createdAt' | 'updatedAt' | 'inferred'>) => {
    const now = Date.now();
    const row: SuspensionWindow = {
      ...payload,
      inferred: false,
      id: createId('sus'),
      createdAt: now,
      updatedAt: now,
    };
    await db.transaction('rw', [db.suspensions, db.stations], async () => {
      await db.suspensions.put(row);
      const stations = await db.stations.where('code').equals(row.stationCode).toArray();
      await Promise.all(
        stations.map((station) =>
          db.stations.update(station.id, { obsStatus: '停测' as StationObsState, updatedAt: now } as never)
        )
      );
      // 若该台站在升级未决清单中，登记时段后即销项
      stations.forEach((station) => resolveUnresolvedSuspension(station.id));
    });
    return row;
  }
);

export const updateSuspension = createAsyncThunk(
  'suspension/updateSuspension',
  async (payload: { id: string; patch: Partial<Omit<SuspensionWindow, 'inferred'>> }) => {
    await db.suspensions.update(payload.id, { ...payload.patch, updatedAt: Date.now() } as never);
    return payload;
  }
);

/** 登记复测日：停测时段封口，台站恢复运行（复测后照旧排标定） */
export const resumeStation = createAsyncThunk(
  'suspension/resumeStation',
  async (payload: { id: string; endDate: string }) => {
    const now = Date.now();
    const window = await db.suspensions.get(payload.id);
    if (!window) throw new Error('停测时段不存在');
    await db.transaction('rw', [db.suspensions, db.stations], async () => {
      await db.suspensions.update(payload.id, { endDate: payload.endDate, updatedAt: now } as never);
      const stations = await db.stations.where('code').equals(window.stationCode).toArray();
      await Promise.all(
        stations.map((station) =>
          db.stations.update(station.id, { obsStatus: '运行' as StationObsState, updatedAt: now } as never)
        )
      );
    });
    return { id: payload.id, endDate: payload.endDate, stationCode: window.stationCode };
  }
);

export const removeSuspension = createAsyncThunk(
  'suspension/removeSuspension',
  async (id: string) => {
    await db.suspensions.delete(id);
    return id;
  }
);

/** 直接切换台站观测状态（无时段时计量站会先挂起，不算超期） */
export const setStationObsState = createAsyncThunk(
  'suspension/setStationObsState',
  async (payload: { stationId: string; state: StationObsState }) => {
    const now = Date.now();
    await db.stations.update(payload.stationId, { obsStatus: payload.state, updatedAt: now } as never);
    return payload;
  }
);

/**
 * 按台站码对账（由台网中心侧发起；失败后也由本动作重试）。
 * 对平的台站：给计量站侧尚未认账的标定写 acknowledgedAt；
 * 已认过的标定（acknowledgedAt 有值）一律不回退、不改写。
 */
export const runReconcile = createAsyncThunk('suspension/runReconcile', async (_, { getState }) => {
  const state = getState() as RootState;
  const stations = state.array.stations;
  const windows = state.suspension.windows;
  const instruments = state.instrument.instruments;
  const calibrations = state.calibration.calibrations;

  const report = reconcileLedgers({ stations, windows, instruments, calibrations });

  // 仅对"对平"且计量站尚未认账的标定落 acknowledgedAt；重试不回退已有认账时间
  const matchedCodes = new Set(
    report.items.filter((item) => item.status === 'matched').map((item) => item.stationCode)
  );
  const stationCodeById = new Map(stations.map((station) => [station.id, station.code]));
  const now = report.reconciledAt;
  const pendingCalibIds = calibrations
    .filter((row) => row.acknowledgedAt === null)
    .filter((row) => {
      const instrument = instruments.find((item) => item.id === row.instrumentId);
      return instrument ? matchedCodes.has(stationCodeById.get(instrument.stationId) ?? '') : false;
    })
    .map((row) => row.id);
  if (pendingCalibIds.length > 0) {
    await db.calibrations
      .where('id')
      .anyOf(pendingCalibIds)
      .modify((row) => {
        // 二次确认：liveQuery 回流间隙中可能已被认账，绝不覆盖
        if (row.acknowledgedAt === null) row.acknowledgedAt = now;
        row.updatedAt = now;
      });
  }
  return report;
});

/** 刷新未决清单（中心补登记后销项） */
export const refreshUnresolved = createAsyncThunk('suspension/refreshUnresolved', async () => {
  return readUnresolvedSuspensions();
});

const suspensionSlice = createSlice({
  name: 'suspension',
  initialState,
  reducers: {
    setWindows(state, action: PayloadAction<SuspensionWindow[]>) {
      state.windows = action.payload;
    },
    setReconcileReport(state, action: PayloadAction<ReconcileReport | null>) {
      state.report = action.payload;
    },
    setSuspensionError(state, action: PayloadAction<string | null>) {
      state.error = action.payload;
    },
    setSuspensionReceipt(state, action: PayloadAction<string>) {
      state.lastReceipt = action.payload;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(runReconcile.pending, (state) => {
        state.reconciling = true;
        state.error = null;
      })
      .addCase(runReconcile.fulfilled, (state, action) => {
        state.reconciling = false;
        state.report = action.payload;
        const { matched, failed, total } = action.payload;
        state.lastReceipt =
          failed === 0
            ? `对账完成：${matched}/${total} 个台站全部对平，计量站结论已认账`
            : `对账完成：对平 ${matched}/${total}，${failed} 个未对平，请按台站码核对后重试（已认结论不回退）`;
      })
      .addCase(runReconcile.rejected, (state, action) => {
        state.reconciling = false;
        state.error = action.error.message ?? '对账失败，可由台网中心侧重试';
      })
      .addCase(refreshUnresolved.fulfilled, (state, action) => {
        state.unresolved = action.payload;
      })
      .addCase(createSuspension.fulfilled, (state, action) => {
        state.unresolved = state.unresolved.filter(
          (item) => item.stationCode !== action.payload.stationCode
        );
      });
  },
});

export const { setWindows, setReconcileReport, setSuspensionError, setSuspensionReceipt } =
  suspensionSlice.actions;

let started = false;

/** 启动停测时段表实时订阅（幂等） */
export function startSuspensionSubscription(dispatch: (action: unknown) => void): void {
  if (started) return;
  started = true;
  watchTable<SuspensionWindow>(() => db.suspensions).subscribe((rows) => {
    dispatch(setWindows(rows));
  });
}

/* ------------------------------ Selector ------------------------------ */

export const selectSuspensionState = (state: WithSuspension): SuspensionSliceState => state.suspension;
export const selectSuspensions = (state: WithSuspension): SuspensionWindow[] => state.suspension.windows;
export const selectReconcileReport = (state: WithSuspension): ReconcileReport | null =>
  state.suspension.report;
export const selectUnresolvedSuspensions = (state: WithSuspension): UnresolvedSuspension[] =>
  state.suspension.unresolved;
export const selectSuspensionReceipt = (state: WithSuspension): string => state.suspension.lastReceipt;

/** 台站码 → 停测时段（升序） */
export const selectWindowsByStationCode = (
  state: WithSuspension
): Record<string, SuspensionWindow[]> => {
  const result: Record<string, SuspensionWindow[]> = {};
  state.suspension.windows.forEach((window) => {
    const list = result[window.stationCode] ?? [];
    list.push(window);
    result[window.stationCode] = list;
  });
  Object.values(result).forEach((list) => list.sort((a, b) => a.startDate.localeCompare(b.startDate)));
  return result;
};

export default suspensionSlice.reducer;
