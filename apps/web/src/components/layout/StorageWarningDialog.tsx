import { Children, Fragment, useRef, type ReactNode } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import type { StorageMountIssue, StorageMountKey } from '@tracearr/shared';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { formatList } from '@/lib/listFormat';

const FAQ_URL = 'https://docs.tracearr.com/faq#pages-are-slow-to-load-on-unraid';

const TEMPLATE_DEFAULTS: Record<StorageMountKey, string> = {
  postgres: '/mnt/user/appdata/tracearr/postgres',
  redis: '/mnt/user/appdata/tracearr/redis',
  appData: '/mnt/user/appdata/tracearr/data',
};

/** A path may wrap after a slash, never inside a name; <wbr> adds nothing to the copied text. */
function breakAfterSlashes(text: string): ReactNode {
  const parts = text.split('/');
  return parts.map((part, i) =>
    i < parts.length - 1 ? (
      <Fragment key={i}>
        {part}/<wbr />
      </Fragment>
    ) : (
      part
    )
  );
}

function PathCode({ children }: { children?: ReactNode }) {
  return (
    <code className="bg-muted rounded px-1 py-0.5 font-mono text-[0.85em] select-all">
      {Children.map(children, (child) =>
        typeof child === 'string' ? breakAfterSlashes(child) : child
      )}
    </code>
  );
}

const COMPONENTS = { strong: <strong />, code: <PathCode /> };

type PoolIssue = StorageMountIssue & { placement: { kind: 'pool' } };
type SplitIssue = StorageMountIssue & { placement: { kind: 'split' } };

const isPool = (issue: StorageMountIssue): issue is PoolIssue => issue.placement.kind === 'pool';
const isSplit = (issue: StorageMountIssue): issue is SplitIssue => issue.placement.kind === 'split';

export const affectsDatabase = (issues: StorageMountIssue[]) =>
  issues.some((issue) => issue.key === 'postgres');

function CurrentPaths({ issues, database }: { issues: StorageMountIssue[]; database: boolean }) {
  const { t } = useTranslation('settings');
  return (
    <p>
      {issues
        .filter((issue) => issue.currentPath)
        .map((issue) => (
          <span key={issue.key}>
            <Trans
              t={t}
              i18nKey="storageWarning.isSetTo"
              values={{ field: t(`storageWarning.fields.${issue.key}`), path: issue.currentPath }}
              components={COMPONENTS}
            />{' '}
          </span>
        ))}
      <Trans
        t={t}
        i18nKey={database ? 'storageWarning.overheadDatabase' : 'storageWarning.overheadData'}
        components={COMPONENTS}
      />
    </p>
  );
}

function ChangeStep({ issue }: { issue: PoolIssue }) {
  const { t } = useTranslation('settings');
  const code = useRef<HTMLElement>(null);
  const field = t(`storageWarning.fields.${issue.key}`);
  return (
    <li>
      <Trans
        t={t}
        i18nKey="storageWarning.pool.change"
        values={{ field }}
        components={COMPONENTS}
      />
      <div className="mt-1 flex items-start gap-2">
        <code
          ref={code}
          className="bg-muted min-w-0 flex-1 overflow-x-auto rounded px-2 py-1 font-mono text-xs select-all"
        >
          {breakAfterSlashes(issue.placement.newPath)}
        </code>
        <CopyButton
          value={issue.placement.newPath}
          label={t('storageWarning.pool.copyPath', { field })}
          selectTarget={() => code.current}
          variant="ghost"
          size="icon-sm"
          className="shrink-0"
        />
      </div>
    </li>
  );
}

function PoolSteps({
  issues,
  database,
  clears,
}: {
  issues: PoolIssue[];
  database: boolean;
  clears: boolean;
}) {
  const { t } = useTranslation('settings');
  const pools = new Set(issues.map((issue) => issue.placement.pool));
  const [pool] = pools;
  const onlyPostgres = issues.length === 1 && issues[0]?.key === 'postgres';
  return (
    <>
      <CurrentPaths issues={issues} database={database} />
      <p>
        {pools.size === 1 ? (
          <Trans
            t={t}
            i18nKey={
              onlyPostgres
                ? 'storageWarning.pool.alreadyDatabase'
                : 'storageWarning.pool.alreadyData'
            }
            values={{ pool }}
            components={COMPONENTS}
          />
        ) : (
          t('storageWarning.pool.alreadyPools')
        )}
      </p>
      <ol className="list-decimal space-y-2 pl-4">
        <li>{t('storageWarning.pool.openEdit')}</li>
        {issues.map((issue) => (
          <ChangeStep key={issue.key} issue={issue} />
        ))}
        <li>{t('storageWarning.pool.apply')}</li>
      </ol>
      {clears && <p>{t('storageWarning.pool.clears')}</p>}
    </>
  );
}

const isArrayDisk = (name: string) => /^disk\d+$/.test(name);
const onArray = (issue: SplitIssue) => issue.placement.disks.some(isArrayDisk);
const joinNames = (names: string[]) => [...new Set(names)].join(', ');

interface SplitSentence {
  key: `storageWarning.split.${'arrayDatabase' | 'poolsDatabase' | 'arrayData' | 'poolsData'}`;
  values: Record<string, string>;
}

function SplitSteps({ issues, split }: { issues: StorageMountIssue[]; split: SplitIssue[] }) {
  const { t, i18n } = useTranslation('settings');
  const fields = (group: SplitIssue[]) =>
    formatList(
      i18n.language,
      group.map((issue) => t(`storageWarning.fields.${issue.key}`))
    );
  const postgres = split.find((issue) => issue.key === 'postgres');
  const others = split.filter((issue) => issue.key !== 'postgres');
  const othersOnArray = others.filter(onArray);
  const othersOnPools = others.filter((issue) => !onArray(issue));

  const sentences: SplitSentence[] = [];
  if (postgres) {
    sentences.push(
      onArray(postgres)
        ? {
            key: 'storageWarning.split.arrayDatabase',
            values: { disks: joinNames(postgres.placement.disks.filter(isArrayDisk)) },
          }
        : {
            key: 'storageWarning.split.poolsDatabase',
            values: { pools: joinNames(postgres.placement.disks) },
          }
    );
  }
  if (othersOnArray.length > 0) {
    sentences.push({
      key: 'storageWarning.split.arrayData',
      values: {
        field: fields(othersOnArray),
        disks: joinNames(
          othersOnArray.flatMap((issue) => issue.placement.disks.filter(isArrayDisk))
        ),
      },
    });
  }
  if (othersOnPools.length > 0) {
    sentences.push({
      key: 'storageWarning.split.poolsData',
      values: {
        field: fields(othersOnPools),
        pools: joinNames(othersOnPools.flatMap((issue) => issue.placement.disks)),
      },
    });
  }

  const arraySplit = split.filter(onArray);
  // currentPath is /mnt/user/<share>/..., always set for shfs, which is the only source of a split
  const share = arraySplit[0]?.currentPath?.split('/')[3] ?? 'appdata';
  return (
    <>
      <CurrentPaths issues={issues} database={affectsDatabase(issues)} />
      {sentences.map(({ key, values }) => (
        <p key={key}>
          <Trans t={t} i18nKey={key} values={values} components={COMPONENTS} />
        </p>
      ))}
      {arraySplit.length > 0 && (
        <ol className="list-decimal space-y-2 pl-4">
          <li>{t('storageWarning.split.stop')}</li>
          <li>
            <Trans
              t={t}
              i18nKey="storageWarning.split.shares"
              values={{ share }}
              components={COMPONENTS}
            />
          </li>
          <li>{t('storageWarning.split.move')}</li>
          <li>{t('storageWarning.split.start')}</li>
        </ol>
      )}
    </>
  );
}

function GenericSteps({
  issues,
  examplePool,
}: {
  issues: StorageMountIssue[];
  examplePool: string;
}) {
  const { t } = useTranslation('settings');
  return issues.map((issue) => {
    const field = t(`storageWarning.fields.${issue.key}`);
    const database = issue.key === 'postgres';
    const example = (issue.currentPath ?? TEMPLATE_DEFAULTS[issue.key]).replace(
      /^\/mnt\/user\//,
      `/mnt/${examplePool}/`
    );
    return (
      <div key={issue.key} className="space-y-3">
        <p>
          {issue.currentPath ? (
            <Trans
              t={t}
              i18nKey={
                database
                  ? 'storageWarning.unknown.isSetToDatabase'
                  : 'storageWarning.unknown.isSetToData'
              }
              values={{ field, path: issue.currentPath }}
              components={COMPONENTS}
            />
          ) : (
            <Trans
              t={t}
              i18nKey={
                database
                  ? 'storageWarning.unknown.otherFuseDatabase'
                  : 'storageWarning.unknown.otherFuseData'
              }
              values={{ field, fsType: issue.fsType }}
              components={COMPONENTS}
            />
          )}
        </p>
        <p>
          <Trans
            t={t}
            i18nKey={
              database ? 'storageWarning.unknown.fixDatabase' : 'storageWarning.unknown.fixData'
            }
            values={{ field, example }}
            components={COMPONENTS}
          />
        </p>
      </div>
    );
  });
}

/**
 * A split anywhere means moving files first, so no mount gets a new path. Otherwise each
 * pool mount gets its exact path, and an unknown one gets an example on a known pool.
 */
function Steps({ issues }: { issues: StorageMountIssue[] }) {
  const split = issues.filter(isSplit);
  if (split.length > 0) return <SplitSteps issues={issues} split={split} />;
  const pool = issues.filter(isPool);
  const unknown = issues.filter((issue) => !isPool(issue));
  return (
    <>
      {pool.length > 0 && (
        <PoolSteps issues={pool} database={affectsDatabase(pool)} clears={unknown.length === 0} />
      )}
      {unknown.length > 0 && (
        <GenericSteps issues={unknown} examplePool={pool[0]?.placement.pool ?? 'cache'} />
      )}
    </>
  );
}

export function StorageWarningDialog({
  issues,
  open,
  onClose,
}: {
  issues: StorageMountIssue[];
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation(['settings', 'common']);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {t(
              affectsDatabase(issues) ? 'storageWarning.titleDatabase' : 'storageWarning.titleData'
            )}
          </DialogTitle>
        </DialogHeader>

        <div className="text-muted-foreground space-y-3 text-sm">
          <Steps issues={issues} />
          <p>
            <a
              href={FAQ_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline underline-offset-4"
            >
              {t('storageWarning.faq')}
            </a>
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('common:actions.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
