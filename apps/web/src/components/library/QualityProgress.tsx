import { Progress } from '@/components/ui/progress';

interface QualityProgressProps {
  count1080p: number;
  count4k: number;
  total: number;
}

export function QualityProgress({ count1080p, count4k, total }: QualityProgressProps) {
  const highQualityCount = count1080p + count4k;
  const percentage = total > 0 ? Math.round((highQualityCount / total) * 100) : 0;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">1080p+ Content</span>
        <span className="text-sm font-medium tabular-nums">{percentage}%</span>
      </div>
      <Progress value={percentage} className="h-2" />
      <p className="text-muted-foreground text-xs">
        {highQualityCount.toLocaleString()} of {total.toLocaleString()} items
      </p>
    </div>
  );
}
