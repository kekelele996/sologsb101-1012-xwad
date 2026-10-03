# sologsb101-1012 地震台阵仪器标定与布设台账

面向地震台阵建设与运维班组的纯前端单页应用：把台站布设、仪器安装与逐次标定结果写成可追溯的台账。数据全部保存在浏览器本地（IndexedDB），不依赖任何后端服务或外部接口。

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env && docker compose up -d --build
```

启动完成后访问：**http://localhost:22812**

常用命令：

```bash
docker compose ps                 # 查看容器状态
docker compose logs -f frontend   # 查看 nginx 访问日志
docker compose down               # 停止并移除容器
docker compose up -d --build      # 修改代码后重新构建
```

> 宿主端口由 `.env` 中的 `FRONTEND_PORT` 控制（默认 22812）。
> 容器为纯静态 nginx，无数据库服务、不挂载任何命名卷，可随时删除重建。

## 二、技术栈

| 层次 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | React 18.3（函数组件 + Hooks） | 页面全部 `lazy` 懒加载并 `Suspense` 兜底 |
| 语言 | TypeScript 5.6（strict） | 构建脚本执行 `tsc --noEmit` 类型检查 |
| UI 组件 | Ant Design 5.22 + @ant-design/icons | 中文语言包，表格 / 表单 / Modal / 徽标 |
| 构建 | Vite 5 | 产物 `dist/`，交给 nginx 托管 |
| 状态管理 | Redux Toolkit 2 + react-redux 9 | `arraySlice` / `instrumentSlice` / `calibrationSlice` / `suspensionSlice` |
| 路由 | React Router 6（`createBrowserRouter`） | 路径与提示词逐字一致，支持深链刷新 |
| 持久化 | Dexie 4（IndexedDB，库名 `gbseisarray`） | 结构版本 v3 + upgrade 迁移 + liveQuery 订阅 |
| 容器 | node:20-alpine 构建 → nginx:alpine 运行 | 多阶段构建，运行阶段 `chmod -R a+rX` |

## 三、路由与功能模块

| 路由 | 页面 | 消费模型 | 主要交互 |
| --- | --- | --- | --- |
| `/arrays` | 台阵与台站台账 | Array、Station、Instrument | 新建/编辑/删除台阵，按布设日期、运行状态与孔径分档筛选；卡片回显台站数、仪器数与标定合格率，可一键按经纬度重算孔径 |
| `/stations/:id/instruments` | 台站仪器登记与安装位置维护 | Station、Instrument | 新增/编辑/删除台站（经纬度范围校验 + 度分秒显示、基岩类型、高程），登记仪器（类型/型号/序列号**唯一性校验**/安装日期/状态），登记后自动生成下一次标定待办 |
| `/calibrations` | 标定记录台（计量站侧） | Calibration、Instrument | 录入灵敏度、自噪与脉冲响应结论（按类型区间自动初判）、灵敏度相对上次的变化、批量改结论、灵敏度趋势折线图；对平的记录显示「中心已认账」，认过的结论对账重试不回退 |
| `/suspensions` | 停测对账中心（台网中心侧） | Station、SuspensionWindow、Calibration（只读） | 维护台站观测状态与停测起止时段、登记复测日恢复运行；按台站码发起对账 / 失败重试；旧数据升级补不出时段的台站单列 |
| `/replacements` | 合格评定与更换提醒 | Replace、Calibration、Instrument、SuspensionWindow | 按 365 天周期（扣减停测天数）评定：复测后到期的照旧算超期，停测中扣减后未到期与「时段待登记」台站只挂起不进提醒；登记更换并推进状态机（待更换→已更换→已复核），流转到「已更换」时回写仪器序列号 |
| `/geometry` | 台阵几何视图与结构版本 | 全部模型 | 实算孔径与台站间距、SVG 几何平面图与辐射距离、按台阵汇总标定结论、结构版本查看、全量 JSON 导入导出 |

带 `:id` 的层级路由在直接深链访问时同样可用：若 IndexedDB 中查不到该台阵，页面渲染 `<RouteMissingPanel>` 友好空态（含「返回台阵台账」与可用 id 快捷跳转），不会白屏。

## 四、目录结构

```
sologsb101-1012/
├── README.md
├── docker-compose.yml          # name: gbseisarray，不写 version
├── Dockerfile                  # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
├── nginx.conf                  # try_files $uri $uri/ /index.html; + gzip
├── .env / .env.example         # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── .gitignore
└── frontend/
    ├── Dockerfile              # 前端独立构建用（同样多阶段 + chmod -R a+rX）
    ├── nginx.conf              # 前端独立托管用
    ├── .dockerignore
    ├── package.json            # build = tsc --noEmit && vite build
    ├── tsconfig.json
    ├── vite.config.ts
    ├── index.html
    ├── public/favicon.svg
    └── src/
        ├── main.tsx            # Provider + ConfigProvider + RouterProvider
        ├── App.tsx             # 侧边导航 + 顶部上下文条 + 页脚，并启动各表订阅
        ├── types/              # array / station / instrument / calibration / replace / suspension / reconcile / filter
        ├── stores/             # arraySlice / instrumentSlice / calibrationSlice / suspensionSlice / store.ts
        ├── components/common/  # QualifyTag / FilterBar / StatBadge / EmptyPanel / RouteMissingPanel
        ├── hooks/              # useIdbTable / useCalibHistory（到期测算走停测扣减口径）
        ├── pages/              # ArrayList / StationInstruments / CalibrationBoard / SuspensionCenter / ReplaceBoard / GeometryView
        ├── router/index.tsx    # 路由表（路径与提示词逐字一致）
        ├── scripts/            # check-rules / check-migration / check-seed（纯逻辑、升级迁移与播种的可执行校验）
        ├── styles/main.css
        └── utils/              # geo.ts（Haversine/孔径）/ db.ts（Dexie 封装+v3 迁移）/ export.ts（导入导出与结论）
```

## 五、本地开发

```bash
cd frontend
npm install
npm run dev            # http://localhost:22812
npm run build          # 类型检查 + 生产构建
npm run preview        # 预览构建产物
npm run check:rules    # 停测扣减 / 挂起 / 对账纯逻辑校验
npm run check:migration # v2→v3 升级迁移校验（fake-indexeddb）
npm run check:seed     # 全新库播种与对账闭环校验
```

## 六、两侧分账与停测规则

- **职责边界（各管各的）**：台网中心只管台站、台站码与停测起止时段（`suspensionSlice` + `/suspensions`）；计量站只管标定记录、灵敏度与脉冲响应结论（`calibrationSlice` + `/calibrations`）。两侧数据各自落库，**只按台站码对账**，不互改对方字段。
- **周期扣减**：标定周期 365 个自然日，停测窗口覆盖的自然日从周期中扣掉；实际到期日 = 名义到期日 + 已停测天数（`types/suspension.ts` 的 `evaluateDue`，重叠窗口自动去重）。
- **复测后照旧排期**：停测时段封口（登记复测日、台站恢复运行）后，若实际到期日已过，照样算超期并进更换提醒。
- **停测期间够不到期不提醒**：停测窗口内、扣减后仍未到期的仪器标记 `suspended-ok`；台网中心只标了停测状态、还没登记停测时段的台站标记 `pending-period`——两类都**只挂起，不算超期、不进更换提醒**，等中心补登记。
- **对账**：在「停测对账中心」按台站码发起；结果分 对平 / 中心缺台站 / 计量站缺标定 / 台站码重复。失败后由**中心侧重试**；对平时给计量站侧标定写 `acknowledgedAt` 认账时间，**已认过的结论重试一律不回退**。
- **旧数据升级（v3）**：只有停测状态的老台站，按该站**最近一次标定日期的次日**补推一段「未复测」停测窗口（标记 inferred，等中心核对复测日）；连标定日期都查不到的台站补不出时段，**单列**到页面顶部未决清单（localStorage `gbseisarray:unresolved-suspensions`），补登记后自动销项。

## 七、数据存储说明

- **存储位置**：浏览器 IndexedDB，库名 `gbseisarray`，当前结构版本 `v3`。读写统一经 `frontend/src/utils/db.ts` 封装，页面组件不直接触碰 Dexie 实例。
- **数据表**：`arrays`（台阵）、`stations`（台站，含 `obsStatus` 观测状态）、`instruments`（仪器）、`calibrations`（标定，含 `acknowledgedAt` 认账时间）、`replaces`（更换）、`suspensions`（停测时段，按台站码挂账）。
- **升级迁移**：`db.version(1)` 保留初版结构；`db.version(2)` 补齐索引并回填默认字段；`db.version(3)` 新增 `suspensions` 表、台站观测状态与标定认账字段，并把旧的"仅停测状态"按最近标定日期补成停测时段（补不出的单列）；调整字段结构时递增 `DB_VERSION` 并补迁移。
- **首屏播种**：`initDatabase()` 在 `arrays` 表为空时执行幂等播种，生成互相引用的演示数据（2 个台阵 / 5 个台站 / 8 台仪器 / 14 条标定 / 3 条更换 / 3 段停测时段），并刻意覆盖：1 次不合格标定（自噪超标）、复测后到期超期（LTX03）、停测中扣减后未到期（HX01，挂起不提醒）、只标停测状态未登记时段（HX02，pending-period）、停测前已超期（LTX02）等场景。
- **实时同步**：`utils/db.ts` 的 `watchTable()` 基于 Dexie `liveQuery` 订阅表变化，`App.tsx` 挂载时启动订阅并把数据 dispatch 到 Redux slice，页面只读 selector。
- **业务规则**：标定周期 365 天，超期判断先扣减停测自然日（详见上一节）；响应结论自动初判规则为「灵敏度落在类型区间内（宽频带 800~3000、短周期 100~800、强震 0.1~5）且自噪 ≤ 3.5」，最终以标定报告为准；仪器序列号全局唯一；更换状态机为 待更换 → 已更换 → 已复核，流转到「已更换」时把新序列号回写到仪器档案并置为在用。
- **备份与恢复**：`/geometry` 页可导出包含六张表（含 suspensions）的 JSON 快照，支持「覆盖导入」与「追加导入（重新分配 id，停测时段按台站码保留）」；备份时间写入 `localStorage`，页脚与几何页均展示结构版本号。
- **离线可用**：应用为纯静态资源，无任何网络请求；换浏览器或清空站点数据后数据不跟随，需通过 JSON 备份迁移。
