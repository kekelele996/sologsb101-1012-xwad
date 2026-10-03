/**
 * 模块 5：/suspensions 停测对账中心（台网中心侧）
 * 台网中心只管两件事：台站 / 台站码、停测起止时段；
 * 计量站侧的标定记录、灵敏度与响应结论在本页只读展示，并按台站码对账。
 *
 * - 停测自然日从标定周期扣减（计量站侧到期测算）；
 * - 只标停测状态、还没登记时段的台站，计量站先挂起不算超期，本页催登记；
 * - 对账失败由中心侧重试，计量站认过的结论不回退；
 * - 旧数据升级补不出时段的台站单列在顶部。
 */
import { useEffect, useMemo, useState } from 'react';
import {
  App as AntdApp,
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Descriptions,
  Form,
  Input,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Timeline,
  Typography,
} from 'antd';
import {
  CheckCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import StatBadge from '@/components/common/StatBadge';
import EmptyPanel from '@/components/common/EmptyPanel';
import { useAppDispatch, useAppSelector } from '@/stores/store';
import { selectArrays, selectStations } from '@/stores/arraySlice';
import { selectInstruments } from '@/stores/instrumentSlice';
import { selectCalibrations } from '@/stores/calibrationSlice';
import {
  createSuspension,
  removeSuspension,
  resumeStation,
  runReconcile,
  selectReconcileReport,
  selectSuspensions,
  selectUnresolvedSuspensions,
  setStationObsState,
  updateSuspension,
} from '@/stores/suspensionSlice';
import { RECONCILE_STATUS_LABEL, type ReconcileItem } from '@/types/reconcile';
import { STATION_OBS_STATES, type StationObsState } from '@/types/station';
import { evaluateDue, dueStateText, type SuspensionWindow } from '@/types/suspension';
import { CALIBRATION_CYCLE_DAYS } from '@/types/instrument';
import { initDatabase } from '@/utils/db';

interface WindowFormValues {
  stationCode: string;
  startDate: dayjs.Dayjs | null;
  endDate: dayjs.Dayjs | null;
  reason: string;
  operator: string;
  remark: string;
}

interface StationSuspensionRow {
  stationCode: string;
  stationId: string;
  arrayName: string;
  obsStatus: StationObsState;
  windows: SuspensionWindow[];
  instrumentCount: number;
  latestCalibrationDate: string | null;
  /** 该站名下仪器的到期测算汇总 */
  dueSummary: Array<{ overdue: boolean; held: boolean; text: string }>;
}

export default function SuspensionCenter() {
  const dispatch = useAppDispatch();
  const { message } = AntdApp.useApp();

  const arrays = useAppSelector(selectArrays);
  const stations = useAppSelector(selectStations);
  const instruments = useAppSelector(selectInstruments);
  const calibrations = useAppSelector(selectCalibrations);
  const windows = useAppSelector(selectSuspensions);
  const unresolved = useAppSelector(selectUnresolvedSuspensions);
  const report = useAppSelector(selectReconcileReport);
  const reconciling = useAppSelector((state) => state.suspension.reconciling);

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [resumeTarget, setResumeTarget] = useState<SuspensionWindow | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<WindowFormValues>();

  useEffect(() => {
    if (arrays.length === 0) void initDatabase();
  }, [arrays.length]);

  const arrayNameById = useMemo(() => {
    const map = new Map(arrays.map((array) => [array.id, array.name]));
    return map;
  }, [arrays]);

  /** 台站行：中心台账（状态 + 停测时段）为主，计量站数据只做只读摘要 */
  const rows = useMemo<StationSuspensionRow[]>(() => {
    const windowsByCode = new Map<string, SuspensionWindow[]>();
    windows.forEach((window) => {
      const list = windowsByCode.get(window.stationCode) ?? [];
      list.push(window);
      windowsByCode.set(window.stationCode, list);
    });
    return stations
      .map((station) => {
        const stationInstruments = instruments.filter((instrument) => instrument.stationId === station.id);
        const ownCalibrations = calibrations.filter((calibration) =>
          stationInstruments.some((instrument) => instrument.id === calibration.instrumentId)
        );
        const latest = [...ownCalibrations].sort((a, b) => b.date.localeCompare(a.date))[0];
        const stationWindows = (windowsByCode.get(station.code) ?? []).sort((a, b) =>
          b.startDate.localeCompare(a.startDate)
        );
        const dueSummary = stationInstruments.map((instrument) => {
          const rowsOf = ownCalibrations
            .filter((row) => row.instrumentId === instrument.id)
            .sort((a, b) => b.date.localeCompare(a.date));
          const due = evaluateDue({
            baseDate: rowsOf[0]?.date ?? instrument.installDate,
            cycleDays: CALIBRATION_CYCLE_DAYS,
            windows: stationWindows,
            stationState: station.obsStatus,
          });
          return {
            overdue: due.state === 'overdue',
            held: due.state === 'pending-period' || due.state === 'suspended-ok',
            text: dueStateText(due),
          };
        });
        return {
          stationCode: station.code,
          stationId: station.id,
          arrayName: arrayNameById.get(station.arrayId) ?? '未知台阵',
          obsStatus: station.obsStatus ?? '运行',
          windows: stationWindows,
          instrumentCount: stationInstruments.length,
          latestCalibrationDate: latest?.date ?? null,
          dueSummary,
        };
      })
      .sort((a, b) => a.stationCode.localeCompare(b.stationCode, 'zh-Hans-CN'));
  }, [arrayNameById, calibrations, instruments, stations, windows]);

  const stats = useMemo(() => {
    const suspended = rows.filter((row) => row.obsStatus === '停测').length;
    const missingPeriod = rows.filter(
      (row) => row.obsStatus === '停测' && row.windows.length === 0
    ).length;
    const overdueStations = new Set(
      rows.filter((row) => row.dueSummary.some((item) => item.overdue)).map((row) => row.stationCode)
    ).size;
    return {
      stations: rows.length,
      suspended,
      missingPeriod,
      overdueStations,
      windows: windows.length,
      unresolved: unresolved.length,
    };
  }, [rows, windows.length, unresolved.length]);

  const openCreate = (presetCode?: string) => {
    setEditingId(null);
    form.setFieldsValue({
      stationCode: presetCode ?? stations[0]?.code ?? '',
      startDate: dayjs(),
      endDate: null,
      reason: '基建施工停测',
      operator: '台网中心值班员',
      remark: '',
    });
    setModalOpen(true);
  };

  const openEdit = (window: SuspensionWindow) => {
    setEditingId(window.id);
    form.setFieldsValue({
      stationCode: window.stationCode,
      startDate: dayjs(window.startDate),
      endDate: window.endDate ? dayjs(window.endDate) : null,
      reason: window.reason,
      operator: window.operator,
      remark: window.remark,
    });
    setModalOpen(true);
  };

  const submit = async () => {
    const values = await form.validateFields();
    const start = values.startDate ? values.startDate.format('YYYY-MM-DD') : '';
    const end = values.endDate ? values.endDate.format('YYYY-MM-DD') : '';
    if (start && end && end.localeCompare(start) < 0) {
      message.warning('复测日期不能早于停测起始日');
      return;
    }
    setSubmitting(true);
    try {
      const payload = {
        stationCode: values.stationCode.trim(),
        startDate: start,
        endDate: end,
        reason: values.reason.trim(),
        operator: values.operator.trim(),
        remark: values.remark?.trim() ?? '',
      };
      if (editingId) {
        await dispatch(updateSuspension({ id: editingId, patch: payload })).unwrap();
        message.success('停测时段已更新');
      } else {
        await dispatch(createSuspension(payload)).unwrap();
        message.success(`已登记 ${payload.stationCode} 停测时段，台站状态置为停测`);
      }
      setModalOpen(false);
    } finally {
      setSubmitting(false);
    }
  };

  const handleResume = async () => {
    if (!resumeTarget) return;
    const endDate = dayjs().format('YYYY-MM-DD');
    await dispatch(resumeStation({ id: resumeTarget.id, endDate })).unwrap();
    message.success(`${resumeTarget.stationCode} 已复测恢复运行，停测天数已扣减，到期照旧排标定`);
    setResumeTarget(null);
  };

  const handleToggleState = async (row: StationSuspensionRow, state: StationObsState) => {
    await dispatch(setStationObsState({ stationId: row.stationId, state })).unwrap();
    message.success(
      state === '停测'
        ? `${row.stationCode} 已标记停测；未登记时段前计量站先挂起，不算超期`
        : `${row.stationCode} 已恢复运行`
    );
  };

  const handleReconcile = async () => {
    const result = await dispatch(runReconcile()).unwrap();
    if (result.failed === 0) message.success(`对账完成：${result.matched}/${result.total} 全部对平`);
    else message.warning(`对账有 ${result.failed} 个未对平，按台站码核对后可点重试（已认结论不回退）`);
  };

  const statusTagColor = (status: ReconcileItem['status']): string => {
    switch (status) {
      case 'matched':
        return 'green';
      case 'calibration-missing':
        return 'orange';
      case 'center-missing':
        return 'red';
      default:
        return 'volcano';
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="gb-brand-bar" />

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <Typography.Title level={4} style={{ margin: '0 0 4px', color: '#1e3a5f' }}>
            停测对账中心（台网中心侧）
          </Typography.Title>
          <p className="gb-hint">
            中心管台站、台站码与停测起止；计量站管标定记录、灵敏度与响应结论，两侧按台站码对账。
            停测自然日从标定周期扣减；复测后到期的照旧排标定，停测期间够不到期的不进更换提醒。
          </p>
        </div>
        <Space wrap>
          <Button
            icon={<SafetyCertificateOutlined />}
            loading={reconciling}
            onClick={() => void handleReconcile()}
          >
            {report ? '重新对账（重试）' : '按台站码对账'}
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => openCreate()}>
            登记停测时段
          </Button>
        </Space>
      </div>

      <div className="gb-stats-row">
        <StatBadge label="台站总数" value={stats.stations} suffix="个" tone="info" />
        <StatBadge
          label="停测中"
          value={stats.suspended}
          suffix="个"
          tone={stats.suspended > 0 ? 'warning' : 'success'}
        />
        <StatBadge
          label="时段待登记"
          value={stats.missingPeriod}
          suffix="个"
          tone={stats.missingPeriod > 0 ? 'danger' : 'success'}
        />
        <StatBadge label="停测时段" value={stats.windows} suffix="段" tone="primary" />
        <StatBadge
          label="复测后超期"
          value={stats.overdueStations}
          suffix="站"
          tone={stats.overdueStations > 0 ? 'danger' : 'success'}
        />
        {stats.unresolved > 0 ? (
          <StatBadge label="升级补不出时段" value={stats.unresolved} suffix="站" tone="warning" />
        ) : null}
      </div>

      {unresolved.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          message={`旧数据升级：${unresolved.length} 个台站只有停测状态、按最近标定日期也补不出停测时段，已单列`}
          description={
            <Space wrap>
              {unresolved.map((item) => {
                const station = stations.find((row) => row.id === item.stationId);
                return (
                  <Tag key={item.stationId} color="orange" style={{ marginBottom: 4 }}>
                    {item.stationCode}
                    {station ? '' : '（台站档案已不存在）'}
                    <Button
                      type="link"
                      size="small"
                      onClick={() => openCreate(item.stationCode)}
                    >
                      补登记时段
                    </Button>
                  </Tag>
                );
              })}
            </Space>
          }
        />
      ) : null}

      {report ? (
        <Card
          className="gb-panel"
          size="small"
          title={
            <Space>
              <SafetyCertificateOutlined />
              对账报告
              <Tag color={report.failed === 0 ? 'green' : 'orange'}>
                {new Date(report.reconciledAt).toLocaleString('zh-Hans-CN')}
              </Tag>
            </Space>
          }
          extra={
            <Space>
              <Tag color="green">对平 {report.matched}</Tag>
              <Tag color={report.failed > 0 ? 'red' : 'default'}>未对平 {report.failed}</Tag>
              <Button size="small" icon={<ReloadOutlined />} loading={reconciling} onClick={() => void handleReconcile()}>
                重试对账
              </Button>
            </Space>
          }
        >
          <Table
            rowKey={(item) => item.stationCode}
            size="small"
            className="gb-table-compact"
            dataSource={report.items}
            pagination={{ pageSize: 6, showSizeChanger: false }}
            columns={[
              {
                title: '台站码',
                dataIndex: 'stationCode',
                width: 130,
                className: 'gb-mono',
              },
              {
                title: '对账结果',
                width: 150,
                render: (_: unknown, item: ReconcileItem) => (
                  <Tag color={statusTagColor(item.status)}>{RECONCILE_STATUS_LABEL[item.status]}</Tag>
                ),
              },
              { title: '说明', dataIndex: 'reason', ellipsis: true },
              {
                title: '计量站侧（只读）',
                width: 220,
                render: (_: unknown, item: ReconcileItem) =>
                  item.calib ? (
                    <div className="gb-hint">
                      仪器 {item.calib.instruments.length} 台 · 标定 {item.calib.calibrations.length} 次
                      {item.calib.latestCalibrationDate ? ` · 最近 ${item.calib.latestCalibrationDate}` : ''}
                    </div>
                  ) : (
                    <span className="gb-hint">计量站无挂账</span>
                  ),
              },
              {
                title: '认账状态',
                width: 200,
                render: (_: unknown, item: ReconcileItem) =>
                  item.acknowledgedAt ? (
                    <TooltipAck time={item.acknowledgedAt} />
                  ) : (
                    <span className="gb-hint">{item.status === 'matched' ? '本次已认账' : '尚未认账'}</span>
                  ),
              },
            ]}
          />
          <p className="gb-hint" style={{ marginTop: 8 }}>
            对账失败只由台网中心侧发起重试；计量站已认过（有认账时间）的灵敏度与响应结论，重试时一律不回退。
          </p>
        </Card>
      ) : (
        <Alert
          type="info"
          showIcon
          message="尚未对账：点右上角「按台站码对账」，中心台账与计量站标定台账逐站核对"
        />
      )}

      <Card className="gb-panel" size="small" title={`台站停测台账（${rows.length} 个台站）`}>
        {rows.length === 0 ? (
          <EmptyPanel
            title="还没有台站"
            description="先到「台站仪器」页建立台站档案，再回到本页登记施工停测时段。"
            actionText="登记停测时段"
            onAction={() => openCreate()}
            compact
          />
        ) : (
          <Table
            rowKey={(row) => row.stationId}
            className="gb-table-compact"
            dataSource={rows}
            pagination={{ pageSize: 8, showSizeChanger: false }}
            rowClassName={(row) =>
              row.obsStatus === '停测' && row.windows.length === 0 ? 'gb-row-danger' : ''
            }
            columns={[
              {
                title: '台站码 / 台阵',
                width: 190,
                render: (_: unknown, row: StationSuspensionRow) => (
                  <div>
                    <div className="gb-mono">{row.stationCode}</div>
                    <div className="gb-hint">{row.arrayName}</div>
                  </div>
                ),
              },
              {
                title: '观测状态',
                width: 130,
                render: (_: unknown, row: StationSuspensionRow) => (
                  <Select
                    size="small"
                    style={{ width: 100 }}
                    value={row.obsStatus}
                    options={STATION_OBS_STATES.map((state) => ({ label: state, value: state }))}
                    onChange={(value: StationObsState) => void handleToggleState(row, value)}
                  />
                ),
              },
              {
                title: '停测起止（中心登记）',
                width: 300,
                render: (_: unknown, row: StationSuspensionRow) =>
                  row.windows.length === 0 ? (
                    <span className={row.obsStatus === '停测' ? 'gb-danger' : 'gb-hint'}>
                      {row.obsStatus === '停测' ? '停测时段待登记，计量站已挂起' : '无停测记录'}
                    </span>
                  ) : (
                    <Timeline
                      items={row.windows.map((window) => ({
                        color: window.endDate ? 'green' : 'orange',
                        children: (
                          <div>
                            <span className="gb-mono">
                              {window.startDate} ~ {window.endDate || '复测日待登记'}
                            </span>
                            {window.inferred ? <Tag color="purple">升级补推</Tag> : null}
                            <div className="gb-hint">
                              {window.reason}
                              {window.remark ? ` · ${window.remark}` : ''}
                            </div>
                            <Space size={4}>
                              <Button size="small" onClick={() => openEdit(window)}>
                                编辑时段
                              </Button>
                              {!window.endDate ? (
                                <Button
                                  size="small"
                                  type="primary"
                                  onClick={() => setResumeTarget(window)}
                                >
                                  登记复测日
                                </Button>
                              ) : null}
                              <Popconfirm
                                title="删除停测时段"
                                description="仅删除中心侧时段记录，不影响计量站标定结论，确认？"
                                okText="删除"
                                cancelText="取消"
                                okButtonProps={{ danger: true }}
                                onConfirm={() =>
                                  void dispatch(removeSuspension(window.id))
                                    .unwrap()
                                    .then(() => message.success('停测时段已删除'))
                                }
                              >
                                <Button size="small" danger>
                                  删除
                                </Button>
                              </Popconfirm>
                            </Space>
                          </div>
                        ),
                      }))}
                    />
                  ),
              },
              {
                title: '计量站到期口径（只读）',
                width: 240,
                render: (_: unknown, row: StationSuspensionRow) =>
                  row.dueSummary.length === 0 ? (
                    <span className="gb-hint">该站无仪器</span>
                  ) : (
                    <Space direction="vertical" size={2}>
                      {row.dueSummary.map((item, index) => (
                        <Tag
                          key={index}
                          color={item.overdue ? 'red' : item.held ? 'gold' : 'green'}
                          style={{ marginInlineEnd: 0 }}
                        >
                          {item.text}
                        </Tag>
                      ))}
                    </Space>
                  ),
              },
              {
                title: '操作',
                width: 150,
                render: (_: unknown, row: StationSuspensionRow) => (
                  <Space size={6}>
                    <Button size="small" type="primary" onClick={() => openCreate(row.stationCode)}>
                      新增时段
                    </Button>
                    {row.obsStatus === '停测' ? (
                      <Button size="small" onClick={() => void handleToggleState(row, '运行')}>
                        恢复运行
                      </Button>
                    ) : null}
                  </Space>
                ),
              },
            ]}
          />
        )}
      </Card>

      <Descriptions className="gb-panel" size="small" column={1} bordered>
        <Descriptions.Item label="两侧职责">
          台网中心：台站、台站码、停测起止；计量站：标定记录、灵敏度、脉冲响应结论。两侧数据各自落库，
          仅按台站码对账，不互改对方字段。
        </Descriptions.Item>
        <Descriptions.Item label="周期扣减">
          标定周期 {CALIBRATION_CYCLE_DAYS} 天，停测窗口覆盖的自然日从周期扣减；复测封口后实际到期日 =
          名义到期日 + 已停测天数。
        </Descriptions.Item>
        <Descriptions.Item label="不进更换提醒">
          停测期间扣减后仍未到期（suspended-ok）与只标停测状态、时段待登记（pending-period）的仪器，
          计量站只挂起，不算超期。
        </Descriptions.Item>
      </Descriptions>

      <Modal
        open={modalOpen}
        title={editingId ? '编辑停测时段' : '登记停测时段'}
        onCancel={() => setModalOpen(false)}
        onOk={() => void submit()}
        confirmLoading={submitting}
        okText={editingId ? '保存修改' : '登记并置为停测'}
        width={600}
        destroyOnClose
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item name="stationCode" label="台站码（对账键）" rules={[{ required: true, message: '请填写台站码' }]}>
            <Select
              showSearch
              optionFilterProp="label"
              placeholder="如：LTX02"
              options={stations.map((station) => ({
                label: `${station.code}（${arrayNameById.get(station.arrayId) ?? ''}）`,
                value: station.code,
              }))}
            />
          </Form.Item>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="startDate" label="停测起始日" rules={[{ required: true, message: '请选择停测起始日' }]}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="endDate" label="复测 / 恢复日（停测中可留空）">
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="reason" label="停测原因" rules={[{ required: true, message: '请填写停测原因' }]}>
            <Input maxLength={60} placeholder="如：观测楼扩建施工停测" />
          </Form.Item>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="operator" label="登记人" rules={[{ required: true, message: '请填写登记人' }]}>
                <Input maxLength={20} placeholder="如：郑安平" />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} maxLength={100} placeholder="如：施工窗口期未定，复测日期待补" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={resumeTarget !== null}
        title={`登记复测日 · ${resumeTarget?.stationCode ?? ''}`}
        onCancel={() => setResumeTarget(null)}
        onOk={() => void handleResume()}
        okText="复测恢复运行"
        cancelText="取消"
        destroyOnClose
      >
        <p>
          将以今天（{dayjs().format('YYYY-MM-DD')}）作为复测 / 恢复日封口停测时段，台站状态置为「运行」。
        </p>
        <p className="gb-hint">
          <CheckCircleOutlined /> 停测天数已从标定周期扣减；复测后若已到期，计量站照旧排标定并进入超期提醒。
        </p>
      </Modal>
    </div>
  );
}

/** 认账时间标记：计量站已认过的结论，重试不回退 */
function TooltipAck({ time }: { time: number }) {
  return (
    <Tag color="blue" icon={<CheckCircleOutlined />}>
      已认账 {new Date(time).toLocaleDateString('zh-Hans-CN')}
    </Tag>
  );
}
