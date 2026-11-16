import { useId, type ReactNode, type RefObject } from 'react';

interface FlowStepProps {
  /** The number on the rail, which carries a line and no words at all. */
  step: number;
  title: string;
  /** The word beside the heading when the step can be left empty. */
  optional?: string;
  helper: string;
  /** Where the sentence and the problem count land when they point at this step. */
  id: string;
  sectionRef?: RefObject<HTMLElement | null>;
  /** The setting that closes the step, behind a hairline. */
  footer?: ReactNode;
  children: ReactNode;
}

/** One stop on the flow: a number, a heading, a helper, and what the reader builds there. */
export function FlowStep({
  step,
  title,
  optional,
  helper,
  id,
  sectionRef,
  footer,
  children,
}: FlowStepProps) {
  const headingId = useId();

  return (
    <li className="group/step relative pb-9 pl-11 last:pb-2 @max-lg:pb-7 @max-lg:pl-0">
      <span
        aria-hidden
        className="bg-border absolute top-10 bottom-0 left-4 w-px -translate-x-1/2 group-last/step:hidden @max-lg:hidden"
      />
      <section
        ref={sectionRef}
        id={id}
        tabIndex={-1}
        aria-labelledby={headingId}
        className="outline-none"
      >
        <h2
          id={headingId}
          className="flex flex-wrap items-center gap-2 text-lg font-semibold tracking-tight"
        >
          <span className="bg-card dark:bg-card-raised text-muted-foreground absolute top-0 left-0 grid size-8 shrink-0 place-items-center rounded-full border text-xs font-semibold @max-lg:static @max-lg:size-6">
            {step}
          </span>
          {title}
          {optional !== undefined && (
            <span className="text-muted-foreground text-xs font-normal">{optional}</span>
          )}
        </h2>
        <p className="text-muted-foreground mt-1 mb-3.5 text-sm">{helper}</p>

        {children}
        {footer}
      </section>
    </li>
  );
}
