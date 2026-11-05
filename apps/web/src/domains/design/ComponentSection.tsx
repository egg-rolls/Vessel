import {
  Badge,
  type BadgeTone,
  Button,
  type ButtonVariant,
  DataTable,
  type DataTableColumn,
  Field,
  Input,
  KeyValueList,
  PageScaffold,
  SearchInput,
  Section,
  SegmentedTabs,
  Select,
  Stat,
  TableToolbar,
} from '@vessel-agent/plugin-ui';
import { type ReactNode, useState } from 'react';
import { EmptyState, ErrorState, LoadingState } from '../../components/States';
import { t } from '../../i18n';

interface SampleRow {
  key: string;
  name: string;
  tone: BadgeTone;
  owner: string;
}

const SAMPLE_ROWS: readonly SampleRow[] = [
  { key: 'api-alpha', name: 'api-alpha', tone: 'success', owner: 'alice' },
  { key: 'api-beta', name: 'api-beta', tone: 'warn', owner: 'bob' },
  { key: 'worker-1', name: 'worker-1', tone: 'neutral', owner: 'carol' },
];

const BUTTON_VARIANTS: readonly ButtonVariant[] = [
  'plain',
  'primary',
  'danger',
  'dangerGhost',
  'link',
  'chip',
];

const BADGE_TONES: readonly BadgeTone[] = [
  'neutral',
  'accent',
  'info',
  'warn',
  'danger',
  'success',
];

const SAMPLE_TABS = [
  { id: 'overview', labelKey: 'designLab.demo.tabs.overview' },
  { id: 'details', labelKey: 'designLab.demo.tabs.details' },
  { id: 'history', labelKey: 'designLab.demo.tabs.history' },
] as const;

type SampleTabId = (typeof SAMPLE_TABS)[number]['id'];

/** One component sample: name, one-sentence description, live demo. */
function Sample({
  name,
  description,
  children,
}: {
  name: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-1">
        <h3 className="text-md font-semibold text-ink">{name}</h3>
        <p className="max-w-prose text-sm leading-normal text-muted">{description}</p>
      </div>
      {children}
    </div>
  );
}

/** Components area: the standard page skeleton plus every host primitive. */
export function ComponentSection() {
  const [tab, setTab] = useState<SampleTabId>('overview');
  const [query, setQuery] = useState('');

  const columns: DataTableColumn<SampleRow>[] = [
    {
      key: 'name',
      header: t('designLab.demo.table.name'),
      cell: (row) => row.name,
      cellClassName: 'font-mono text-sm',
    },
    {
      key: 'status',
      header: t('designLab.demo.table.status'),
      cell: (row) => <Badge tone={row.tone}>{row.tone}</Badge>,
    },
    {
      key: 'owner',
      header: t('designLab.demo.table.owner'),
      cell: (row) => row.owner,
      hide: 'compact',
    },
  ];

  const tabs = SAMPLE_TABS.map((item) => ({ id: item.id, label: t(item.labelKey) }));

  return (
    <section className="flex flex-col gap-5" aria-labelledby="design-lab-components">
      <div className="flex flex-col gap-1.5">
        <h2 id="design-lab-components" className="font-serif text-xl leading-snug text-ink">
          {t('designLab.components.title')}
        </h2>
        <p className="max-w-prose text-md leading-normal text-muted">
          {t('designLab.components.subtitle')}
        </p>
      </div>

      <Sample
        name={t('designLab.sample.pageScaffold.name')}
        description={t('designLab.sample.pageScaffold.desc')}
      >
        <div className="rounded-md bg-sunken">
          <PageScaffold
            title={t('designLab.demo.pageScaffold.title')}
            subtitle={t('designLab.demo.pageScaffold.subtitle')}
            className="p-4 pb-4"
          >
            <p className="text-md text-muted">{t('designLab.demo.pageScaffold.body')}</p>
          </PageScaffold>
        </div>
      </Sample>

      <Sample
        name={t('designLab.sample.toolbar.name')}
        description={t('designLab.sample.toolbar.desc')}
      >
        <TableToolbar label={t('designLab.demo.toolbar.label')}>
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder={t('designLab.demo.toolbar.placeholder')}
            ariaLabel={t('designLab.demo.toolbar.placeholder')}
            className="grow basis-60 max-w-search"
          />
          <Button variant="plain" onClick={() => setQuery('')}>
            {t('designLab.demo.toolbar.refresh')}
          </Button>
        </TableToolbar>
      </Sample>

      <Sample
        name={t('designLab.sample.dataTable.name')}
        description={t('designLab.sample.dataTable.desc')}
      >
        <DataTable columns={columns} rows={SAMPLE_ROWS} rowKey={(row) => row.key} />
      </Sample>

      <Sample
        name={t('designLab.sample.buttons.name')}
        description={t('designLab.sample.buttons.desc')}
      >
        <div className="flex flex-wrap items-center gap-2">
          {BUTTON_VARIANTS.map((variant) => (
            <Button key={variant} variant={variant}>
              {variant}
            </Button>
          ))}
        </div>
      </Sample>

      <Sample
        name={t('designLab.sample.badges.name')}
        description={t('designLab.sample.badges.desc')}
      >
        <div className="flex flex-wrap items-center gap-2">
          {BADGE_TONES.map((tone) => (
            <Badge key={tone} tone={tone}>
              {tone}
            </Badge>
          ))}
        </div>
      </Sample>

      <Sample
        name={t('designLab.sample.section.name')}
        description={t('designLab.sample.section.desc')}
      >
        <Section
          title={t('designLab.demo.section.title')}
          description={t('designLab.demo.section.description')}
          actions={<Badge tone="accent">section</Badge>}
        >
          <p className="text-md text-muted">{t('designLab.demo.section.body')}</p>
        </Section>
      </Sample>

      <Sample name={t('designLab.sample.form.name')} description={t('designLab.sample.form.desc')}>
        <div className="flex flex-wrap items-start gap-5">
          <Field
            label={t('designLab.demo.form.name')}
            htmlFor="design-lab-name"
            hint={t('designLab.demo.form.nameHint')}
            className="w-60"
          >
            <Input
              id="design-lab-name"
              defaultValue="nightly-report"
              placeholder={t('designLab.demo.form.namePlaceholder')}
            />
          </Field>
          <Field label={t('designLab.demo.form.mode')} htmlFor="design-lab-mode" className="w-60">
            <Select id="design-lab-mode" defaultValue="fast">
              <option value="fast">{t('designLab.demo.form.fast')}</option>
              <option value="thorough">{t('designLab.demo.form.thorough')}</option>
            </Select>
          </Field>
        </div>
      </Sample>

      <Sample name={t('designLab.sample.stat.name')} description={t('designLab.sample.stat.desc')}>
        <div className="flex flex-wrap gap-2">
          <Stat
            label={t('designLab.demo.stat.runs')}
            value="12"
            hint={t('designLab.demo.stat.runsHint')}
            className="w-48"
          />
          <Stat
            label={t('designLab.demo.stat.agents')}
            value="4"
            hint={t('designLab.demo.stat.agentsHint')}
            className="w-48"
          />
        </div>
      </Sample>

      <Sample
        name={t('designLab.sample.keyValue.name')}
        description={t('designLab.sample.keyValue.desc')}
      >
        <KeyValueList
          items={[
            {
              key: 'gateway',
              label: t('designLab.demo.keyValue.gateway'),
              value: 'ws://127.0.0.1:8642',
            },
            {
              key: 'tenant',
              label: t('designLab.demo.keyValue.tenant'),
              value: 'local',
            },
            {
              key: 'protocol',
              label: t('designLab.demo.keyValue.protocol'),
              value: 'vessel.gateway/1',
            },
          ]}
        />
      </Sample>

      <Sample name={t('designLab.sample.tabs.name')} description={t('designLab.sample.tabs.desc')}>
        <SegmentedTabs
          label={t('designLab.demo.tabs.label')}
          tabs={tabs}
          value={tab}
          onChange={setTab}
          className="mt-0"
        />
      </Sample>

      <Sample
        name={t('designLab.sample.states.name')}
        description={t('designLab.sample.states.desc')}
      >
        <div className="flex flex-col gap-2.5">
          <EmptyState
            title={t('designLab.demo.states.emptyTitle')}
            description={t('designLab.demo.states.emptyDesc')}
            action={<Button variant="primary">{t('designLab.demo.toolbar.refresh')}</Button>}
          />
          <LoadingState label={t('designLab.demo.states.loading')} />
          <ErrorState message={t('designLab.demo.states.error')} />
        </div>
      </Sample>
    </section>
  );
}
