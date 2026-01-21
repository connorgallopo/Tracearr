import { useState } from 'react';
import { Film, Music } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { TopListChart } from '@/components/charts';
import { EmptyState } from '@/components/library';
import { useLibraryCodecs } from '@/hooks/queries';
import type { CodecBreakdown } from '@tracearr/shared';

interface CodecDistributionSectionProps {
  serverId?: string | null;
}

/**
 * Convert CodecBreakdown to TopListChart format
 */
function toChartData(breakdown: CodecBreakdown | undefined) {
  if (!breakdown?.codecs) return undefined;
  return breakdown.codecs.map((item) => ({
    name: item.codec,
    value: item.count,
    subtitle: `${item.percentage}%`,
  }));
}

/**
 * Codec Distribution Section
 *
 * Displays video and audio codec breakdowns for Movies/TV and Music.
 * Uses horizontal bar charts for easy comparison of codec counts.
 */
export function CodecDistributionSection({ serverId }: CodecDistributionSectionProps) {
  const [activeTab, setActiveTab] = useState<'video' | 'music'>('video');
  const codecs = useLibraryCodecs(serverId);

  const videoData = toChartData(codecs.data?.video);
  const audioData = toChartData(codecs.data?.audio);
  const channelsData = toChartData(codecs.data?.channels);
  const musicData = toChartData(codecs.data?.music);

  const hasVideoData = codecs.data?.video.total ?? 0 > 0;
  const hasMusicData = codecs.data?.music.total ?? 0 > 0;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base font-medium">Codec Distribution</CardTitle>
      </CardHeader>
      <CardContent>
        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'video' | 'music')}>
          <TabsList className="mb-4">
            <TabsTrigger value="video" className="gap-2">
              <Film className="h-4 w-4" />
              Movies / TV
              {codecs.data?.video.total !== undefined && (
                <span className="text-muted-foreground ml-1">
                  ({codecs.data.video.total.toLocaleString()})
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="music" className="gap-2">
              <Music className="h-4 w-4" />
              Music
              {codecs.data?.music.total !== undefined && (
                <span className="text-muted-foreground ml-1">
                  ({codecs.data.music.total.toLocaleString()})
                </span>
              )}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="video">
            {!codecs.isLoading && !hasVideoData ? (
              <EmptyState
                icon={Film}
                title="No video content"
                description="Video codec data will appear once movies or TV shows are in your library."
              />
            ) : (
              <div className="grid gap-6 md:grid-cols-3">
                <div>
                  <h4 className="mb-3 text-sm font-medium">Video Codecs</h4>
                  <TopListChart
                    data={videoData}
                    isLoading={codecs.isLoading}
                    height={220}
                    valueLabel="Items"
                    colorful
                  />
                </div>
                <div>
                  <h4 className="mb-3 text-sm font-medium">Audio Codecs</h4>
                  <TopListChart
                    data={audioData}
                    isLoading={codecs.isLoading}
                    height={220}
                    valueLabel="Items"
                    colorful
                  />
                </div>
                <div>
                  <h4 className="mb-3 text-sm font-medium">Audio Channels</h4>
                  <TopListChart
                    data={channelsData}
                    isLoading={codecs.isLoading}
                    height={220}
                    valueLabel="Items"
                    colorful
                  />
                </div>
              </div>
            )}
          </TabsContent>

          <TabsContent value="music">
            {!codecs.isLoading && !hasMusicData ? (
              <EmptyState
                icon={Music}
                title="No music content"
                description="Music codec data will appear once music tracks are in your library."
              />
            ) : (
              <div>
                <h4 className="mb-3 text-sm font-medium">Audio Codecs</h4>
                <TopListChart
                  data={musicData}
                  isLoading={codecs.isLoading}
                  height={280}
                  valueLabel="Tracks"
                  colorful
                />
              </div>
            )}
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
