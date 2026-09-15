import { Badge } from '@/components/ui/badge';

export function StepBadge({ n }: { n: number }) {
  return <Badge className="size-6 rounded-full p-0 tabular-nums">{n}</Badge>;
}
