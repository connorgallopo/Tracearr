import { useTranslation } from 'react-i18next';
import { ChevronDown } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { capFragments, SENTENCE_SECTIONS, type DescribeFragment } from '@/lib/automations';
import { cn } from '@/lib/utils';

interface SentenceProps {
  fragments: readonly DescribeFragment[];
  onFocusNode: (nodeId: string) => void;
  className?: string;
}

/** The steps a blank sentence still has to be filled from, drawn as invitations. */
const SLOTS: readonly string[] = [SENTENCE_SECTIONS.triggers, SENTENCE_SECTIONS.actions];

/** The punctuation that joins clauses sits outside the slot, not inside it. */
function splitTail(text: string): [string, string] {
  const match = /[.,;:]+$/.exec(text);
  return match ? [text.slice(0, match.index), match[0]] : [text, ''];
}

/** The automation in one line, where every clause jumps to the row it came from. */
export function Sentence({ fragments, onFocusNode, className }: SentenceProps) {
  const { t } = useTranslation('pages');
  const shown = capFragments(fragments, t);
  // capFragments keeps the objects it was handed and appends its own "+N more" before the
  // scope tail, so the one fragment it invented is the one that came from nowhere.
  const overflow = shown.find((fragment) => !fragments.includes(fragment));

  return (
    <p className={cn('text-muted-foreground text-base leading-relaxed', className)}>
      {shown.map((fragment, index) => {
        const key = `${fragment.nodeId ?? 'text'}:${index}`;
        if (fragment === overflow) {
          return (
            <Badge key={key} variant="secondary">
              {fragment.text}
            </Badge>
          );
        }
        if (fragment.nodeId === null) {
          return <span key={key}>{fragment.text} </span>;
        }

        const nodeId = fragment.nodeId;
        if (SLOTS.includes(nodeId)) {
          const [body, tail] = splitTail(fragment.text);
          return (
            <span key={key}>
              <button
                type="button"
                onClick={() => onFocusNode(nodeId)}
                className="border-primary/65 bg-primary/10 text-primary focus-visible:ring-ring/(--ring-alpha) inline-flex items-center gap-1 rounded-sm border border-dashed px-1.5 py-0.5 text-[0.9375em] focus-visible:ring-[3px] focus-visible:outline-none"
              >
                {body}
                <ChevronDown className="size-3" />
              </button>
              {tail}{' '}
            </span>
          );
        }

        return (
          <span key={key}>
            <button
              type="button"
              onClick={() => onFocusNode(nodeId)}
              className="text-foreground focus-visible:ring-ring/(--ring-alpha) hover:decoration-foreground rounded-sm underline decoration-dotted underline-offset-4 focus-visible:ring-[3px] focus-visible:outline-none"
            >
              {fragment.text}
            </button>{' '}
          </span>
        );
      })}
    </p>
  );
}
