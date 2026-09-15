import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDistanceToNow } from 'date-fns';
import { ArrowLeftRight, ChevronDown, ChevronRight, TriangleAlert } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Label } from '@/components/ui/label';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';
import { ServerPillList } from './ServerPillList';
import type { MergeCandidate, MergeRequest } from './mergeSelection';

export interface MergeConfirmInput {
  sourceUserId: string;
  targetUserId: string;
  confirmSameServerCombine: boolean;
}

export type MergeUsersDialogProps = MergeRequest & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (input: MergeConfirmInput) => void;
  isLoading: boolean;
};

type MergeReviewProps = Omit<MergeUsersDialogProps, 'open' | 'onOpenChange'>;

export function MergeUsersDialog({ open, onOpenChange, ...review }: MergeUsersDialogProps) {
  const [first, second] = review.candidates;
  return (
    // A merge deletes a user and a same-server combine cannot be undone, so the flow
    // uses AlertDialog. Constraint: keep this a single modal root. Nesting a second
    // Dialog/AlertDialog root here broke under Radix's aria-hide-others (both modals'
    // content got marked aria-hidden).
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl"
        {...(review.match ? {} : { 'aria-describedby': undefined })}
      >
        {/* A new pair starts from its own default; a re-render of the same pair keeps the owner's choices. */}
        <MergeReview key={`${first.userId}:${second.userId}`} {...review} />
      </AlertDialogContent>
    </AlertDialog>
  );
}

function MergeReview({
  candidates,
  defaultTargetUserId,
  requiredTargetUserId,
  match,
  sameServer,
  onConfirm,
  isLoading,
}: MergeReviewProps) {
  const { t } = useTranslation(['pages', 'common']);
  const isMobile = useIsMobile();
  const acknowledgeId = useId();
  const [targetUserId, setTargetUserId] = useState(requiredTargetUserId ?? defaultTargetUserId);
  const [acknowledged, setAcknowledged] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const [first, second] = candidates;
  const keep = targetUserId === second.userId ? second : first;
  const fold = keep === first ? second : first;
  const names = { keepName: keep.displayName, foldName: fold.displayName };
  const matchedEmail = match?.type === 'email' ? match.value.toLowerCase() : null;
  const detailsShown = !isMobile || detailsOpen;
  const whatHappens = t('pages:users.mergeWhatHappens');

  return (
    <>
      <AlertDialogHeader>
        <AlertDialogTitle>
          {match ? t('pages:users.mergeTitleSuggestion') : t('pages:users.mergeTitleBulk')}
        </AlertDialogTitle>
        {match && (
          <AlertDialogDescription>
            {match.type === 'username'
              ? t('pages:users.mergeReasonUsername', { value: match.value })
              : match.onUsername
                ? t('pages:users.mergeReasonEmailUsername', { value: match.value })
                : t('pages:users.mergeReasonEmail', { value: match.value })}
          </AlertDialogDescription>
        )}
      </AlertDialogHeader>

      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
        <CandidatePanel
          label={t('pages:users.mergeKeep')}
          candidate={keep}
          matchedEmail={matchedEmail}
          kept
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="self-center justify-self-center"
          aria-label={t('pages:users.mergeSwap')}
          disabled={requiredTargetUserId !== null || isLoading}
          onClick={() => setTargetUserId(fold.userId)}
        >
          <ArrowLeftRight className="rotate-90 sm:rotate-0" />
        </Button>
        <CandidatePanel
          label={t('pages:users.mergeFoldIn')}
          candidate={fold}
          matchedEmail={matchedEmail}
          kept={false}
        />
      </div>
      {requiredTargetUserId !== null && (
        <p className="text-muted-foreground text-sm">
          {t('pages:users.mergeRequired', { name: keep.displayName })}
        </p>
      )}

      <Collapsible open={detailsShown} onOpenChange={setDetailsOpen}>
        {isMobile ? (
          <CollapsibleTrigger asChild>
            <Button type="button" variant="ghost" size="sm" className="-ml-3">
              {detailsShown ? <ChevronDown /> : <ChevronRight />}
              {whatHappens}
            </Button>
          </CollapsibleTrigger>
        ) : (
          <h3 className="text-sm font-medium">{whatHappens}</h3>
        )}
        <CollapsibleContent>
          <ul className="text-muted-foreground mt-2 list-disc space-y-1 pl-5 text-sm">
            <li>
              {fold.sessionCount === undefined
                ? t('pages:users.mergeMovesNoCount', names)
                : t('pages:users.mergeMoves', { ...names, count: fold.sessionCount })}
            </li>
            <li>{t('pages:users.mergeCarriesOver')}</li>
            <li>
              {sameServer
                ? t('pages:users.mergeRulesKept', names)
                : t('pages:users.mergeDeleted', names)}
            </li>
          </ul>
        </CollapsibleContent>
      </Collapsible>

      {sameServer && (
        <Alert className="[&>svg]:text-destructive">
          <TriangleAlert />
          <AlertTitle>{t('pages:users.mergeIrreversibleTitle')}</AlertTitle>
          <AlertDescription className="gap-2">
            <p>{t('pages:users.mergeIrreversibleBody')}</p>
            <p className="flex flex-wrap gap-x-2">
              <span>{t('pages:users.mergeServerLabel')}</span>
              <span className="text-foreground font-medium">
                {sameServer.serverName || t('pages:users.mergeServerUnknown')}
              </span>
            </p>
            <div className="flex items-start gap-2 pt-1">
              <Checkbox
                id={acknowledgeId}
                className="mt-0.5"
                checked={acknowledged}
                disabled={isLoading}
                onCheckedChange={(value) => setAcknowledged(value === true)}
              />
              <Label htmlFor={acknowledgeId} className="text-foreground leading-snug font-normal">
                {t('pages:users.mergeIrreversibleAcknowledge')}
              </Label>
            </div>
          </AlertDescription>
        </Alert>
      )}

      <AlertDialogFooter>
        <AlertDialogCancel disabled={isLoading}>{t('common:actions.cancel')}</AlertDialogCancel>
        <Button
          type="button"
          variant={sameServer ? 'destructive' : 'default'}
          className="max-w-full"
          disabled={isLoading || (sameServer !== null && !acknowledged)}
          onClick={() =>
            onConfirm({
              sourceUserId: fold.userId,
              targetUserId: keep.userId,
              confirmSameServerCombine: sameServer !== null,
            })
          }
        >
          <span className="truncate">
            {t('pages:users.mergeConfirmInto', { keepName: keep.displayName })}
          </span>
        </Button>
      </AlertDialogFooter>
    </>
  );
}

function highlightMatch(text: string, matchedEmail: string | null) {
  return text.toLowerCase() === matchedEmail ? (
    <mark className="bg-primary/20 text-foreground rounded-sm px-1">{text}</mark>
  ) : (
    text
  );
}

function CandidatePanel({
  label,
  candidate,
  matchedEmail,
  kept,
}: {
  label: string;
  candidate: MergeCandidate;
  matchedEmail: string | null;
  kept: boolean;
}) {
  const { t } = useTranslation(['pages']);
  const labelId = useId();
  const activity = candidate.lastActivityAt
    ? t('pages:users.mergeLastActive', {
        relative: formatDistanceToNow(new Date(candidate.lastActivityAt), { addSuffix: true }),
      })
    : t('pages:users.mergeNeverActive');

  return (
    <section
      aria-labelledby={labelId}
      className={cn(
        'flex min-w-0 flex-col gap-2 rounded-lg p-3',
        kept ? 'bg-primary/10' : 'bg-muted/50'
      )}
    >
      <h3
        id={labelId}
        className={cn('text-xs font-medium', kept ? 'text-foreground' : 'text-muted-foreground')}
      >
        {label}
      </h3>
      <div className="min-w-0">
        <p className="truncate font-medium" title={candidate.displayName}>
          {candidate.displayName}
        </p>
        <p className="text-muted-foreground truncate text-sm" title={`@${candidate.username}`}>
          @{highlightMatch(candidate.username, matchedEmail)}
        </p>
      </div>
      {candidate.emails
        .filter((email) => email.toLowerCase() !== candidate.username.toLowerCase())
        .map((email) => (
          <p key={email} className="text-muted-foreground truncate text-sm" title={email}>
            {highlightMatch(email, matchedEmail)}
          </p>
        ))}
      <ServerPillList accounts={candidate.serverUsers} />
      <p className="text-muted-foreground text-xs">
        {activity}
        {candidate.sessionCount !== undefined &&
          ` · ${t('pages:users.mergeSessions', { count: candidate.sessionCount })}`}
      </p>
    </section>
  );
}
