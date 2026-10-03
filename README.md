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
| 状态管理 | Redux Toolkit 2 + react-redux 9 | `arraySlice` / `instrumentSlice` / `calibrationSlice` / `centerSlice` |
| 路由 | React Router 6（`createBrowserRouter`） | 路径与提示词逐字一致，支持深链刷新 |
| 持久化 | Dexie 4（IndexedDB，库名 `gbseisarray`） | 结构版本 v3 + upgrade 迁移 + liveQuery 订阅 |
| 容器 | node:20-alpine 构建 → nginx:alpine 运行 | 多阶段构建，运行阶段 `chmod -R a+rX` |

## 三、路由与功能模块

| 路由 | 页面 | 责任方 | 主要交互 |
| --- | --- | --- | --- |
| `/arrays` | 台阵与台站台账 | 台网中心 | 新建/编辑/删除台阵，按布设日期、运行状态与孔径分档筛选；卡片回显台站数、仪器数与标定合格率，可一键按经纬度重算孔径 |
| `/stations/:id/instruments` | 台站仪器登记与安装位置维护 | 台网中心（台站）+ 计量站（仪器） | 台站经纬度范围校验、度分秒显示、基岩、高程与运行/停测状态；登记仪器（序列号唯一校验）；仪器表的到期天数已扣减停测 |
| `/center` | 台网中心 · 停测登记与台站码对账 | 台网中心 | 登记施工停测起止（复测日期可留空）、按台站码全量对账与**中心侧重试**、旧数据升级补不出停测时段的台站单列 |
| `/calibrations` | 标定记录台 | 计量站 | 录入灵敏度、自噪与脉冲响应结论（按类型区间自动初判）、灵敏度相对上次的变化、批量改结论、灵敏度趋势折线图 |
| `/replacements` | 合格评定与更换提醒 | 计量站 | 停测天数从 365 天周期扣除后评定；复测后仍到期的照常排标定，停测期间够不到期 / 未登记停测时段的停测台站挂起、**不进更换提醒**；登记更换并推进状态机 |
| `/geometry` | 台阵几何视图与结构版本 | 全部模型 | 实算孔径与台站间距、SVG 几何平面图与辐射距离、按台阵汇总标定结论、结构版本查看、全量 JSON 导入导出（七张表） |

### 两边各管各的（台网中心 ↔ 计量站）

- **台网中心**：管台站档案（含运行/停测状态）与停测时段（`suspensions` 表，停测起止）。
- **计量站**：管标定记录、灵敏度、自噪与脉冲响应结论，以及合格评定与更换提醒。
- **对账键**：双方不直接读写对方表，只按**台站码**对账，结果写入 `reconciliations` 台账。
- **停测扣周期**：计量侧推算到期日时，把落在计时窗口内的停测自然日从 365 天周期中扣除（半开区间 `[停测开始, 复测恢复)`，复测当天恢复观测不计停测；仍在停测的计到当天）。
- **挂起规则**：台站标记停测、但中心尚未登记停测时段时，计量侧状态为「停测挂起」，暂不计算超期、不进更换提醒。
- **重试与不回退**：对账失败（台站码缺失 / 停测时段待登记）由台网中心补登后**重试**；计量站已认过（matched）的合格/不合格结论在重试中保持不变、不回退。

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
        ├── App.tsx             # 侧边导航 + 顶部上下文条 + 页脚，并启动各表订阅与首轮对账
        ├── types/              # array / station / instrument / calibration / replace / suspension / reconciliation / filter
        ├── stores/             # arraySlice / instrumentSlice / calibrationSlice / centerSlice / store.ts
        ├── components/common/  # QualifyTag / FilterBar / StatBadge / EmptyPanel / RouteMissingPanel
        ├── hooks/              # useIdbTable / useCalibHistory（停测扣减后的到期推算）
        ├── pages/              # ArrayList / StationInstruments / CenterBoard / CalibrationBoard / ReplaceBoard / GeometryView
        ├── router/index.tsx    # 路由表（路径与提示词逐字一致）
        ├── styles/main.css
        └── utils/              # geo.ts（Haversine/孔径）/ db.ts（Dexie 封装）/ schedule.ts（停测扣减/挂起）/ reconcile.ts（台站码对账/旧数据补时段）/ export.ts（导入导出与结论）
```

## 五、本地开发

```bash
cd frontend
npm install
npm run dev        # http://localhost:22812
npm run build      # 类型检查 + 生产构建
npm run preview    # 预览构建产物
```

## 六、数据存储说明

- **存储位置**：浏览器 IndexedDB，库名 `gbseisarray`，当前结构版本 `v3`。读写统一经 `frontend/src/utils/db.ts` 封装，页面组件不直接触碰 Dexie 实例。
- **数据表（7 张）**：`arrays`（台阵）、`stations`（台站，含运行/停测 `runState`）、`instruments`（仪器）、`calibrations`（标定）、`replaces`（更换）、`suspensions`（台网中心停测时段，按台站码）、`reconciliations`（台站码对账台账）。
- **升级迁移**：
  - `db.version(1)` 初版结构；`db.version(2)` 补齐索引并回填时间戳与必填字段；
  - `db.version(3)` 新增台站 `runState`、`suspensions`、`reconciliations` 两张表，并处理旧数据——旧数据**只有停测状态**（历史上台阵级“停测”先落到其下台站），升级时**按最近一次标定日期补出停测时段**（复测日期留空表示仍停测）；**补不出的**（该停测台站连一次标定都没有）台站码写入 `localStorage` 并在「台网中心」页**单列**待人工核实登记。
- **首屏播种**：`initDatabase()` 在 `arrays` 表为空时执行幂等播种，生成四层互相引用的演示数据（2 个台阵 / 5 个台站 / 8 台仪器 / 14 条标定 / 3 条更换 / 1 段已复测停测），并刻意覆盖：1 次不合格标定（自噪超标）、1 台真超期仪器（LTX01_ST）、1 台复测后扣减 47 天仍在期的仪器（LTX03，不进提醒）、1 台停测中但未登记时段的挂起仪器（HX02，不算超期）、3 条不同状态的更换记录。
- **实时同步**：`utils/db.ts` 的 `watchTable()` 基于 Dexie `liveQuery` 订阅表变化，`App.tsx` 挂载时启动订阅并把数据 dispatch 到 Redux slice（含 centerSlice 的停测/对账两表），页面只读 selector。
- **业务规则**：标定周期 365 天；**台站经登记的停测天数从周期中扣除**（`utils/schedule.ts`），复测后仍到期的照常排标定，停测期间够不到到期与未登记停测时段的停测台站不计超期、不进更换提醒；响应结论自动初判为「灵敏度落在类型区间内（宽频带 800~3000、短周期 100~800、强震 0.1~5）且自噪 ≤ 3.5」，最终以标定报告为准；仪器序列号全局唯一；更换状态机为 待更换 → 已更换 → 已复核，流转到「已更换」时把新序列号回写到仪器档案并置为在用。
- **对账规则**：按台站码对账（`utils/reconcile.ts`），状态为 已对账 / 待计量建档 / 停测时段待登记 / 台站码缺失；失败由台网中心页重试，matched 台站的已认结论与对账时间原样保留。
- **备份与恢复**：`/geometry` 页可导出包含七张表的 JSON 快照，支持「覆盖导入」与「追加导入（重新分配 id，停测/对账跟随新台站码）」；备份时间写入 `localStorage`，页脚与几何页均展示结构版本号。
- **离线可用**：应用为纯静态资源，无任何网络请求；换浏览器或清空站点数据后数据不跟随，需通过 JSON 备份迁移。
