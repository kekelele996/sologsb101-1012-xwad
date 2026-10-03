/**
 * 台网中心工作台：管台站停测起止 + 按台站码与计量站对账。
 * - 停测时段（施工停测 → 复测恢复）由中心登记；
 * - 对账失败后由本页（中心侧）重试，计量站已认过的结论不回退；
 * - 旧数据升级补不出停测时段的台站，单列为「待人工核实」。
 */
import { useEffect, useMemo, useState } from 'react';
import {
  App as AntdApp,
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Form,
  Input,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import {
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  ReloadOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import StatBadge from '@/components/common/StatBadge';
import EmptyPanel from '@/components/common/EmptyPanel';
import { useAppDispatch, useAppSelector } from '@/stores/store';
import { selectArrays, selectStations } from '@/stores/arraySlice';
import {
  createSuspension,
  removeSuspension,
  retryReconcile,
  runReconciliation,
  selectSuspensions,
  updateSuspension,
} from '@/stores/centerSlice';
import {
  isOngoing,
  type Suspension,
  type SuspensionDraft,
} from '@/types/suspension';
import {
  RECONCILE_STATUS_META,
  type Reconciliation,
  type ReconcileStatus,
} from '@/types/reconciliation';
import {
  readUnresolvedSuspensionCodes,
  writeUnresolvedSuspensionCodes,
} from '@/utils/db';
import { initDatabase } from '@/utils/db';

interface SuspensionFormValues {
  stationCode: string;
  range: [dayjs.Dayjs, dayjs.Dayjs | null] | null;
  reason: string;
  operator: string;
  remark: string;
}

const STATUS_COLOR: Record<ReconcileStatus, string> = {
  matched: 'green',
  station_only: 'blue',
  suspension_missing: 'orange',
  orphan: 'red',
};

export default function CenterBoard() {
  const dispatch = useAppDispatch();
  const { message } = AntdApp.useApp();

  const arrays = useAppSelector(selectArrays);
  const stations = useAppSelector(selectStations);
  const suspensions = useAppSelector(selectSuspensions);
  const reconciliations = useAppSelector((state) => state.center.reconciliations);

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [unresolved, setUnresolved] = useState<string[]>([]);
  const [reconciling, setReconciling] = useState(false);
  const [form] = Form.useForm<SuspensionFormValues>();

  useEffect(() => {
    if (arrays.length === 0) void initDatabase();
    setUnresolved(readUnresolvedSuspensionCodes());
  }, [arrays.length]);

  const arrayNameOf = useMemo(() => {
    const map = new Map(stations.map((s) => [s.code, arrays.find((a) => a.id === s.arrayId)?.name ?? '—']));
    return (code: string): string => map.get(code) ?? '—';
  }, [arrays, stations]);

  const runStateOf = useMemo(() => {
    const map = new Map(stations.map((s) => [s.code, s.runState]));
    return (code: string) => map.get(code);
  }, [stations]);

  const totals = useMemo(() => {
    const ongoing = suspensions.filter((s) => isOngoing(s)).length;
    const byStatus = (status: ReconcileStatus) =>
      reconciliations.filter((r) => r.status === status).length;
    return {
      stations: stations.length,
      ongoing,
      registered: suspensions.length,
      matched: byStatus('matched'),
      failed: byStatus('orphan') + byStatus('suspension_missing') + byStatus('station_only'),
      unresolved: unresolved.length,
    };
  }, [reconciliations, stations.length, suspensions, unresolved.length]);

  const openCreate = (presetCode?: string) => {
    setEditingId(null);
    form.setFieldsValue({
      stationCode: presetCode ?? stations[0]?.code ?? '',
      range: [dayjs(), null],
      reason: '台站施工停测',
      operator: '台网中心',
      remark: '',
    });
    setModalOpen(true);
  };

  const openEdit = (row: Suspension) => {
    setEditingId(row.id);
    form.setFieldsValue({
      stationCode: row.stationCode,
      range: [dayjs(row.suspendDate), row.resumeDate ? dayjs(row.resumeDate) : null],
      reason: row.reason,
      operator: row.operator,
      remark: row.remark,
    });
    setModalOpen(true);
  };

  const submit = async () => {
    const values = await form.validateFields();
    const suspendDate = values.range?.[0]?.format('YYYY-MM-DD') ?? dayjs().format('YYYY-MM-DD');
    const resumeDate = values.range?.[1] ? values.range[1].format('YYYY-MM-DD') : '';
    if (resumeDate && resumeDate < suspendDate) {
      message.warning('复测日期不能早于停测开始日期');
      return;
    }
    const payload: SuspensionDraft = {
      stationCode: values.stationCode,
      suspendDate,
      resumeDate,
      reason: values.reason.trim(),
      operator: values.operator.trim(),
      remark: values.remark?.trim() ?? '',
    };
    setSubmitting(true);
    try {
      if (editingId) {
        await dispatch(updateSuspension({ id: editingId, patch: payload })).unwrap();
        message.success('停测时段已更新，计量侧下次对账将按新的起止扣减周期');
      } else {
        await dispatch(createSuspension(payload)).unwrap();
        message.success('停测时段已登记');
      }
      setModalOpen(false);
    } finally {
      setSubmitting(false);
    }
  };

  const handleRunReconcile = async () => {
    setReconciling(true);
    try {
      const report = await dispatch(runReconciliation()).unwrap();
      message.success(
        `对账完成：一致 ${report.matched}、待建档 ${report.stationOnly}、待登记时段 ${report.suspensionMissing}、台站码缺失 ${report.orphan}`
      );
    } finally {
      setReconciling(false);
    }
  };

  const handleRetry = async () => {
    setReconciling(true);
    try {
      await dispatch(retryReconcile()).unwrap();
      message.success('中心侧已重试对账；计量站认过的结论保持不变，不回退');
    } finally {
      setReconciling(false);
    }
  };

  const dismissUnresolved = (code: string) => {
    const next = unresolved.filter((item) => item !== code);
    setUnresolved(next);
    writeUnresolvedSuspensionCodes(next);
  };

  const suspensionColumns = [
    {
      title: '台站码',
      dataIndex: 'stationCode',
      width: 120,
      className: 'gb-mono',
      render: (code: string) => (
        <div>
          <span>{code}</span>
          <div className="gb-hint">{arrayNameOf(code)}</div>
        </div>
      ),
    },
    { title: '停测开始', dataIndex: 'suspendDate', width: 120, className: 'gb-mono' },
    {
      title: '复测恢复',
      dataIndex: 'resumeDate',
      width: 120,
      className: 'gb-mono',
      render: (value: string) => value || <Tag color="orange">停测中</Tag>,
    },
    {
      title: '状态',
      width: 100,
      render: (_: unknown, row: Suspension) =>
        isOngoing(row) ? <Tag color="orange">未复测</Tag> : <Tag color="green">已复测</Tag>,
    },
    { title: '原因', dataIndex: 'reason', ellipsis: true },
    { title: '登记人', dataIndex: 'operator', width: 110 },
    {
      title: '操作',
      width: 170,
      render: (_: unknown, row: Suspension) => (
        <Space size={6}>
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(row)}>
            编辑
          </Button>
          <Popconfirm
            title="删除停测时段"
            description="删除后计量侧将不再扣减这段停测天数，确认？"
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() =>
              void dispatch(removeSuspension(row.id))
                .unwrap()
                .then(() => message.success('停测时段已删除'))
            }
          >
            <Button size="small" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const reconcileColumns = [
    { title: '台站码', dataIndex: 'stationCode', width: 150, className: 'gb-mono' },
    { title: '所属台阵', dataIndex: 'arrayName', width: 170 },
    {
      title: '对账状态',
      dataIndex: 'status',
      width: 130,
      render: (status: ReconcileStatus) => (
        <Tag color={STATUS_COLOR[status]}>{RECONCILE_STATUS_META[status].label}</Tag>
      ),
    },
    { title: '仪器', dataIndex: 'instrumentCount', width: 70, align: 'center' as const },
    { title: '标定', dataIndex: 'calibrationCount', width: 70, align: 'center' as const },
    { title: '停测时段', dataIndex: 'suspensionCount', width: 90, align: 'center' as const },
    {
      title: '计量已认结论',
      dataIndex: 'acknowledgedVerdict',
      width: 120,
      render: (value: string) => value || <span className="gb-hint">—</span>,
    },
    { title: '最近标定', dataIndex: 'latestCalibrationDate', width: 115, className: 'gb-mono' },
    { title: '问题说明 / 重试', dataIndex: 'issue', ellipsis: true, render: (value: string, row: Reconciliation) => (
      <Space direction="vertical" size={0}>
        <span>{value || '—'}</span>
        {row.attempts > 0 ? <span className="gb-hint">已重试 {row.attempts} 次</span> : null}
      </Space>
    ) },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="gb-brand-bar" />

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <Typography.Title level={4} style={{ margin: '0 0 4px', color: '#1e3a5f' }}>
            台网中心 · 停测登记与台站码对账
          </Typography.Title>
          <p className="gb-hint">
            中心管台站与停测起止，计量站管标定记录、灵敏度与响应结论；两边只按台站码对账。停测天数从计量侧标定周期中扣除，
            复测后照常排标定；中心未登记停测时段的，计量侧先挂起、不算超期。
          </p>
        </div>
        <Space wrap>
          <Button icon={<SyncOutlined />} loading={reconciling} onClick={() => void handleRunReconcile()}>
            全量对账
          </Button>
          <Button type="primary" icon={<ReloadOutlined />} loading={reconciling} onClick={() => void handleRetry()}>
            中心侧重试
          </Button>
          <Button type="primary" ghost icon={<PlusOutlined />} onClick={() => openCreate()}>
            登记停测时段
          </Button>
        </Space>
      </div>

      <div className="gb-stats-row">
        <StatBadge label="台站" value={totals.stations} suffix="个" tone="info" />
        <StatBadge label="停测中" value={totals.ongoing} suffix="个" tone="warning" />
        <StatBadge label="停测时段" value={totals.registered} suffix="段" tone="primary" />
        <StatBadge label="已对账" value={totals.matched} suffix="码" tone="success" />
        <StatBadge label="待处理" value={totals.failed} suffix="码" tone={totals.failed > 0 ? 'danger' : 'success'} />
        <StatBadge
          label="升级待核实"
          value={totals.unresolved}
          suffix="个"
          tone={totals.unresolved > 0 ? 'warning' : 'success'}
        />
      </div>

      {totals.failed > 0 ? (
        <Alert
          type="warning"
          showIcon
          message={`有 ${totals.failed} 个台站码对账未通过，请由台网中心补登后点「中心侧重试」`}
          description="台站码缺失需中心补建台站；停测时段待登记需在下表补登停测起止。计量站已认过的合格/不合格结论在重试中不会回退。"
        />
      ) : (
        <Alert type="success" showIcon message="台站码全部对账一致，计量侧结论保持稳定" />
      )}

      {unresolved.length > 0 ? (
        <Card size="small" className="gb-panel" title="旧数据升级 · 待人工核实停测时段">
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 10 }}
            message="以下台站旧数据只有停测状态、且没有任何标定日期，无法自动补出停测开始时间，请人工核实后登记。"
          />
          <Space wrap>
            {unresolved.map((code) => (
              <Tag
                key={code}
                closable
                color="orange"
                onClose={(e) => {
                  e.preventDefault();
                  dismissUnresolved(code);
                }}
              >
                {code}
                <Button type="link" size="small" onClick={() => openCreate(code)}>
                  去登记
                </Button>
              </Tag>
            ))}
          </Space>
        </Card>
      ) : null}

      <Card
        className="gb-panel"
        size="small"
        title={`停测时段台账（${suspensions.length} 段）`}
        extra={<span className="gb-hint">复测日期留空表示仍在停测；恢复后计量周期顺延相应天数</span>}
      >
        {suspensions.length === 0 ? (
          <EmptyPanel
            title="还没有停测时段"
            description="台站施工停测时在此登记起止；未登记停测时段的停测台站，计量侧会先挂起、不计算超期。"
            actionText="登记停测时段"
            onAction={() => openCreate()}
            compact
          />
        ) : (
          <Table
            rowKey="id"
            size="small"
            className="gb-table-compact"
            dataSource={[...suspensions].sort((a, b) => b.suspendDate.localeCompare(a.suspendDate))}
            pagination={false}
            columns={suspensionColumns}
          />
        )}
      </Card>

      <Card
        className="gb-panel"
        size="small"
        title={`台站码对账台账（${reconciliations.length} 个台站码）`}
        extra={
          <span className="gb-hint">
            对账失败后中心侧重试；计量认过结论不回退
          </span>
        }
      >
        {reconciliations.length === 0 ? (
          <EmptyPanel
            title="尚未对账"
            description="点右上角「全量对账」，按台站码核对中心台站与计量侧仪器/标定。"
            actionText="全量对账"
            onAction={() => void handleRunReconcile()}
            compact
          />
        ) : (
          <Table
            rowKey="id"
            size="small"
            className="gb-table-compact"
            dataSource={reconciliations}
            pagination={false}
            columns={reconcileColumns}
          />
        )}
      </Card>

      <p className="gb-hint">
        提示：当前台站运行状态由台网中心维护（运行/停测）。标记为停测但未登记时段的台站共{' '}
        {stations.filter((s) => s.runState === '停测' && !suspensions.some((x) => x.stationCode === s.code)).length}{' '}
        个，这些台站的仪器在计量侧「合格评定与更换」页会显示为停测挂起、不进超期提醒。
      </p>

      <Modal
        open={modalOpen}
        title={editingId ? '编辑停测时段' : '登记停测时段'}
        onCancel={() => setModalOpen(false)}
        onOk={() => void submit()}
        confirmLoading={submitting}
        okText={editingId ? '保存修改' : '登记'}
        destroyOnClose
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item name="stationCode" label="台站（按台站码对账）" rules={[{ required: true, message: '请选择台站' }]}>
            <Select
              showSearch
              optionFilterProp="label"
              options={stations.map((station) => ({
                label: `${station.code} · ${arrayNameOf(station.code)}${
                  runStateOf(station.code) === '停测' ? '（停测中）' : ''
                }`,
                value: station.code,
              }))}
            />
          </Form.Item>
          <Row gutter={12}>
            <Col span={24}>
              <Form.Item
                name="range"
                label="停测开始 ~ 复测恢复（复测日期留空表示仍在停测）"
                rules={[{ required: true, message: '请选择停测开始日期' }]}
              >
                <DatePicker.RangePicker
                  style={{ width: '100%' }}
                  allowEmpty={[false, true]}
                  format="YYYY-MM-DD"
                />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="reason" label="停测原因" rules={[{ required: true, message: '请填写停测原因' }]}>
            <Input maxLength={60} placeholder="如：台站施工改造临时停测" />
          </Form.Item>
          <Form.Item name="operator" label="登记人">
            <Input maxLength={20} placeholder="如：台网中心" />
          </Form.Item>
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} maxLength={100} placeholder="如：复测后灵敏度合格，周期顺延" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
