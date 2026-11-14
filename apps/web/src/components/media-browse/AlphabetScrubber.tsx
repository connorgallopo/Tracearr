import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CatalogLetterBucket } from '@tracearr/shared';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

export const SCRUBBER_LETTERS = [
  '#',
  'A',
  'B',
  'C',
  'D',
  'E',
  'F',
  'G',
  'H',
  'I',
  'J',
  'K',
  'L',
  'M',
  'N',
  'O',
  'P',
  'Q',
  'R',
  'S',
  'T',
  'U',
  'V',
  'W',
  'X',
  'Y',
  'Z',
] as const;

export type ScrubberLetter = (typeof SCRUBBER_LETTERS)[number];

interface AlphabetScrubberProps {
  activeLetter: ScrubberLetter | null;
  onJump: (letter: ScrubberLetter) => void;
  /** Bucket counts from /catalog/letters; a zero-count letter is disabled
   * (there is no row to jump to). Undefined while loading: all enabled. */
  letters?: CatalogLetterBucket[];
  /** 'rail' is the sticky vertical strip beside the grid; 'select' collapses into a filter Sheet on touch widths. */
  variant?: 'rail' | 'select';
  className?: string;
}

/**
 * One tab stop: the container owns focus and moves aria-activedescendant
 * with ArrowUp/Down, Enter jumps to the focused letter. Individual letters
 * are never independently focusable.
 */
export function AlphabetScrubber({
  activeLetter,
  onJump,
  letters,
  variant = 'rail',
  className,
}: AlphabetScrubberProps) {
  const { t } = useTranslation('pages');
  const countByLetter = useMemo(
    () => (letters ? new Map(letters.map((bucket) => [bucket.letter, bucket.count])) : null),
    [letters]
  );
  const isEmptyLetter = (letter: ScrubberLetter) =>
    countByLetter !== null && (countByLetter.get(letter) ?? 0) === 0;
  const initialIndex = useMemo(() => {
    if (!activeLetter) return 0;
    const idx = SCRUBBER_LETTERS.indexOf(activeLetter);
    return idx >= 0 ? idx : 0;
  }, [activeLetter]);
  const [focusedIndex, setFocusedIndex] = useState(initialIndex);
  const [containerFocused, setContainerFocused] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const label = t('media.grid.scrubber.label');

  if (variant === 'select') {
    return (
      <Select value={activeLetter ?? ''} onValueChange={(value) => onJump(value as ScrubberLetter)}>
        <SelectTrigger aria-label={label} className={className}>
          <SelectValue placeholder={label} />
        </SelectTrigger>
        <SelectContent>
          {SCRUBBER_LETTERS.map((letter) => (
            <SelectItem key={letter} value={letter} disabled={isEmptyLetter(letter)}>
              {letter}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  const moveFocus = (delta: number) => {
    setFocusedIndex((prev) => {
      const next = Math.min(Math.max(prev + delta, 0), SCRUBBER_LETTERS.length - 1);
      return next;
    });
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowRight':
        event.preventDefault();
        moveFocus(1);
        break;
      case 'ArrowUp':
      case 'ArrowLeft':
        event.preventDefault();
        moveFocus(-1);
        break;
      case 'Home':
        event.preventDefault();
        setFocusedIndex(0);
        break;
      case 'End':
        event.preventDefault();
        setFocusedIndex(SCRUBBER_LETTERS.length - 1);
        break;
      case 'Enter':
      case ' ': {
        event.preventDefault();
        const letter = SCRUBBER_LETTERS[focusedIndex];
        if (letter && !isEmptyLetter(letter)) onJump(letter);
        break;
      }
      default:
        break;
    }
  };

  return (
    <div
      ref={containerRef}
      role="listbox"
      aria-label={label}
      aria-orientation="vertical"
      tabIndex={0}
      aria-activedescendant={`alpha-scrubber-opt-${focusedIndex}`}
      onKeyDown={handleKeyDown}
      onFocus={() => setContainerFocused(true)}
      onBlur={() => setContainerFocused(false)}
      className={cn(
        'text-muted-foreground sticky top-[120px] flex h-fit flex-col items-center gap-px text-xs leading-tight font-semibold focus-visible:outline-none',
        className
      )}
    >
      <span aria-live="polite" className="sr-only">
        {activeLetter ? t('media.grid.scrubber.current', { letter: activeLetter }) : ''}
      </span>
      {SCRUBBER_LETTERS.map((letter, index) => {
        const isActive = activeLetter === letter;
        const isFocused = containerFocused && index === focusedIndex;
        const isEmpty = isEmptyLetter(letter);
        return (
          <span
            key={letter}
            id={`alpha-scrubber-opt-${index}`}
            role="option"
            aria-selected={isActive}
            aria-current={isActive ? 'true' : undefined}
            aria-disabled={isEmpty || undefined}
            onMouseDown={(event) => {
              event.preventDefault();
              setFocusedIndex(index);
              if (!isEmpty) onJump(letter);
            }}
            className={cn(
              'cursor-pointer rounded px-1',
              isActive && 'bg-primary/10 text-primary dark:bg-primary/12',
              isFocused && !isActive && 'ring-ring ring-1',
              isEmpty && 'text-muted-foreground/30 cursor-default'
            )}
          >
            {letter}
          </span>
        );
      })}
    </div>
  );
}
