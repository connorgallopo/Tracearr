import type { ReactNode } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';

/** Owner-authored html goes through an empty sandbox: never allow-scripts together with allow-same-origin. */
export function HtmlPreviewDialog({
  open,
  onOpenChange,
  title,
  subject,
  meta,
  html,
  loading = false,
  modal = true,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  subject?: string;
  meta?: ReactNode;
  html: string | null;
  loading?: boolean;
  /** False when nested under another open Sheet/Dialog: Radix's modal hideOthers() would otherwise aria-hide the parent. */
  modal?: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} modal={modal}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {subject && <DialogDescription>{subject}</DialogDescription>}
        </DialogHeader>
        {meta}
        {loading ? (
          <Skeleton data-testid="html-preview-loading" className="h-[60vh] w-full" />
        ) : (
          html !== null && (
            <iframe
              title={title}
              sandbox=""
              srcDoc={html}
              className="h-[60vh] w-full rounded-md border bg-white"
            />
          )
        )}
      </DialogContent>
    </Dialog>
  );
}
