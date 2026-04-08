import { View } from 'react-native';
import { CheckCircle, XCircle, SkipForward } from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { colors } from '@/lib/theme';
import type { ActionResult } from '@tracearr/shared';
import { useTranslation } from '@tracearr/translations/mobile';

interface ActionResultsListProps {
  results: ActionResult[];
}

/**
 * Display a list of action execution results from a V2 rule trigger.
 * Shows success/failure/skipped status for each action.
 */
export function ActionResultsList({ results }: ActionResultsListProps) {
  const { t } = useTranslation(['mobile']);

  if (results.length === 0) return null;

  return (
    <View className="gap-2">
      <Text className="text-muted-foreground text-sm font-medium">
        {t('mobile:actionsExecuted')}
      </Text>
      <View className="gap-1.5">
        {results.map((result, index) => (
          <View key={index} className="flex-row items-center gap-2">
            {result.skipped ? (
              <SkipForward size={16} color={colors.text.muted.dark} />
            ) : result.success ? (
              <CheckCircle size={16} color={colors.success} />
            ) : (
              <XCircle size={16} color={colors.error} />
            )}
            <Text className="text-sm capitalize">{result.actionType.replace(/_/g, ' ')}</Text>
            {result.skipped && result.skipReason && (
              <Text className="text-muted-foreground text-xs">({result.skipReason})</Text>
            )}
            {!result.success && !result.skipped && result.errorMessage && (
              <Text className="text-destructive text-xs">({result.errorMessage})</Text>
            )}
          </View>
        ))}
      </View>
    </View>
  );
}
