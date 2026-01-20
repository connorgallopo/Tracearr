interface CodecBreakdownProps {
  hevc: number;
  h264: number;
  av1: number;
  total: number;
}

export function CodecBreakdown({ hevc, h264, av1, total }: CodecBreakdownProps) {
  const other = total - hevc - h264 - av1;

  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
      <div className="text-center">
        <div className="text-2xl font-bold">{hevc.toLocaleString()}</div>
        <div className="text-muted-foreground text-sm">HEVC</div>
      </div>
      <div className="text-center">
        <div className="text-2xl font-bold">{h264.toLocaleString()}</div>
        <div className="text-muted-foreground text-sm">H.264</div>
      </div>
      <div className="text-center">
        <div className="text-2xl font-bold">{av1.toLocaleString()}</div>
        <div className="text-muted-foreground text-sm">AV1</div>
      </div>
      {other > 0 && (
        <div className="text-center">
          <div className="text-2xl font-bold">{other.toLocaleString()}</div>
          <div className="text-muted-foreground text-sm">Other</div>
        </div>
      )}
    </div>
  );
}
