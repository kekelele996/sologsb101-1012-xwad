/**
 * 迁移验证：先以 v2 结构灌入"旧数据"（含只有停测状态、有/无标定日期的台站），
 * 再打开当前（v3）数据库触发 upgrade，校验：
 * - obsStatus 落库、按最近标定日期补出停测时段（inferred、未复测）；
 * - 补不出的单列到 localStorage 未决清单；
 * - 标定补 acknowledgedAt=null。
 */
import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { db, DB_VERSION, readUnresolvedSuspensions } from '../src/utils/db';

// localStorage shim
const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() {
    return store.size;
  },
} as Storage;

let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    console.error(`  ✗ ${msg}`);
    failed += 1;
  }
}

async function seedV2(): Promise<void> {
  // 同名库、旧版本结构
  const old = new Dexie('gbseisarray');
  old.version(2).stores({
    arrays: 'id, name, state, apertureKm, deployDate, department, updatedAt',
    stations: 'id, arrayId, code, lat, lng, elevM, bedrock, updatedAt',
    instruments: 'id, stationId, type, model, serialNo, installDate, state, updatedAt',
    calibrations: 'id, instrumentId, date, sensitivity, selfNoise, responseVerdict, updatedAt',
    replaces: 'id, instrumentId, state, date, newSerialNo, updatedAt',
  });
  await old.table('arrays').put({
    id: 'arr1', name: '旧台阵', apertureKm: 10, stationCount: 2, deployDate: '2020-01-01',
    state: '运行中', department: 'x', createdAt: 1, updatedAt: 1,
  });
  // A：旧数据带非标准 suspended 标记、有标定 → 应补时段（次日起、未复测）
  await old.table('stations').put({
    id: 'stA', arrayId: 'arr1', code: 'OLDA', lat: 1, lng: 1, elevM: 1, bedrock: '花岗岩',
    siteNote: '', suspended: true, createdAt: 1, updatedAt: 1,
  });
  // B：旧数据 obsStatus='停测'、但无任何标定 → 应进未决清单
  await old.table('stations').put({
    id: 'stB', arrayId: 'arr1', code: 'OLDB', lat: 1, lng: 1, elevM: 1, bedrock: '砂岩',
    siteNote: '', obsStatus: '停测', createdAt: 1, updatedAt: 1,
  });
  // C：正常运行站
  await old.table('stations').put({
    id: 'stC', arrayId: 'arr1', code: 'OLDC', lat: 1, lng: 1, elevM: 1, bedrock: '石灰岩',
    siteNote: '', createdAt: 1, updatedAt: 1,
  });
  await old.table('instruments').bulkPut([
    {
      id: 'inA', stationId: 'stA', type: '宽频带', model: 'M', serialNo: 'SN-A',
      installDate: '2021-01-01', state: '在用', remark: '', createdAt: 1, updatedAt: 1,
    },
    {
      id: 'inC', stationId: 'stC', type: '宽频带', model: 'M', serialNo: 'SN-C',
      installDate: '2021-01-01', state: '在用', remark: '', createdAt: 1, updatedAt: 1,
    },
  ]);
  await old.table('calibrations').bulkPut([
    {
      id: 'ca1', instrumentId: 'inA', date: '2025-05-10', sensitivity: 1500, selfNoise: 1,
      responseVerdict: '合格', operator: 'o', agency: 'g', remark: '', createdAt: 1, updatedAt: 1,
    },
    {
      id: 'ca2', instrumentId: 'inC', date: '2026-01-01', sensitivity: 1500, selfNoise: 1,
      responseVerdict: '合格', operator: 'o', agency: 'g', remark: '', createdAt: 1, updatedAt: 1,
    },
  ]);
  await old.close();
}

async function main(): Promise<void> {
  await seedV2();
  await db.open();
  assert(db.verno === DB_VERSION, `升级后结构版本为 v${DB_VERSION}（got v${db.verno}）`);

  const stations = await db.stations.toArray();
  const stA = stations.find((s) => s.id === 'stA');
  const stB = stations.find((s) => s.id === 'stB');
  const stC = stations.find((s) => s.id === 'stC');
  assert(stA?.obsStatus === '停测', 'OLDA 观测状态落库为停测');
  assert(stB?.obsStatus === '停测', 'OLDB 观测状态为停测');
  assert(stC?.obsStatus === '运行', 'OLDC 缺省补为运行');

  const windows = await db.suspensions.toArray();
  assert(windows.length === 1, `只补出 1 段停测时段（got ${windows.length}）`);
  const w = windows[0];
  assert(w?.stationCode === 'OLDA', '补推时段挂在 OLDA 台站码下');
  assert(w?.startDate === '2025-05-11', `起始日为最近标定次日 2025-05-11（got ${w?.startDate}）`);
  assert(w?.endDate === '', '未复测，endDate 留空');
  assert(w?.inferred === true, '标记 inferred=true');

  const unresolved = readUnresolvedSuspensions();
  assert(unresolved.length === 1 && unresolved[0]?.stationCode === 'OLDB',
    `OLDB 无标定日期，单列入未决清单（got ${unresolved.map((u) => u.stationCode).join(',')}）`);

  const calA = await db.calibrations.get('ca1');
  assert(calA?.acknowledgedAt === null, '历史标定补 acknowledgedAt=null');

  db.close();
  if (failed > 0) {
    console.error(`\n${failed} 个断言失败`);
    process.exit(1);
  }
  console.log('\n迁移验证全部通过');
}

void main();
