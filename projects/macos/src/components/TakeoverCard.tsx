import {
  isSafeLiveViewUrl,
  parseTakeoverTarget,
  type TakeoverRecord,
} from "@pi-in-the-sky/client/protocol";
import { useCallback, useEffect, useRef } from "react";
import {
  Animated,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { THEME } from "../theme";

type TakeoverCardProps = {
  readonly takeover: TakeoverRecord;
  readonly onResume: (id: string) => void;
};

const PROMINENT_HOLD_MS = 2000;
const SHRINK_DURATION_MS = 320;

export function TakeoverCard({ takeover, onResume }: TakeoverCardProps) {
  const parsedTarget = parseTakeoverTarget(takeover.url);
  const displayHostname = parsedTarget?.hostname ?? takeover.hostname;
  const isPunycode = parsedTarget?.isPunycode ?? false;
  const safeLiveViewUrl =
    takeover.liveViewUrl && isSafeLiveViewUrl(takeover.liveViewUrl)
      ? takeover.liveViewUrl
      : null;

  const prominence = useRef(new Animated.Value(1)).current;
  const shrinkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flashHostname = useCallback(() => {
    if (shrinkTimerRef.current !== null) {
      clearTimeout(shrinkTimerRef.current);
      shrinkTimerRef.current = null;
    }
    prominence.stopAnimation();
    prominence.setValue(1);
    shrinkTimerRef.current = setTimeout(() => {
      shrinkTimerRef.current = null;
      Animated.timing(prominence, {
        toValue: 0,
        duration: SHRINK_DURATION_MS,
        useNativeDriver: false,
      }).start();
    }, PROMINENT_HOLD_MS);
  }, [prominence]);

  useEffect(() => {
    flashHostname();
    return () => {
      if (shrinkTimerRef.current !== null) {
        clearTimeout(shrinkTimerRef.current);
        shrinkTimerRef.current = null;
      }
      prominence.stopAnimation();
    };
  }, [displayHostname, flashHostname, prominence]);

  const handleOpenLiveView = () => {
    if (!safeLiveViewUrl) {
      return;
    }
    flashHostname();
    void Linking.openURL(safeLiveViewUrl);
  };

  const pillPaddingVertical = prominence.interpolate({
    inputRange: [0, 1],
    outputRange: [5, 14],
  });
  const pillPaddingHorizontal = prominence.interpolate({
    inputRange: [0, 1],
    outputRange: [10, 16],
  });
  const hostFontSize = prominence.interpolate({
    inputRange: [0, 1],
    outputRange: [13, 22],
  });
  const pillBackgroundColor = prominence.interpolate({
    inputRange: [0, 1],
    outputRange: [THEME.inputBg, THEME.blueTint],
  });
  const pillBorderColor = prominence.interpolate({
    inputRange: [0, 1],
    outputRange: [THEME.border, THEME.blue],
  });

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <Text style={styles.title}>Browser takeover</Text>
        <Text style={styles.hostBadgeLabel}>Verified by host</Text>
      </View>

      <Animated.View
        style={[
          styles.hostPill,
          {
            paddingVertical: pillPaddingVertical,
            paddingHorizontal: pillPaddingHorizontal,
            backgroundColor: pillBackgroundColor,
            borderColor: pillBorderColor,
          },
        ]}
      >
        <Animated.Text
          style={[styles.hostText, { fontSize: hostFontSize }]}
          numberOfLines={1}
        >
          {displayHostname}
        </Animated.Text>
        {isPunycode ? (
          <Text style={styles.punycodeTag}>IDN (punycode)</Text>
        ) : null}
      </Animated.View>

      <View style={styles.agentNoteBox}>
        <Text style={styles.agentNoteLabel}>Agent note</Text>
        <Text style={styles.agentNoteBody}>{takeover.reason}</Text>
      </View>

      <View style={styles.row}>
        {safeLiveViewUrl ? (
          <Pressable
            style={styles.secondaryButton}
            onPress={handleOpenLiveView}
          >
            <Text style={styles.secondaryButtonText}>Open Live View</Text>
          </Pressable>
        ) : null}
        <Pressable
          style={styles.primaryButton}
          onPress={() => onResume(takeover.id)}
        >
          <Text style={styles.primaryButtonText}>Done</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: 16,
    borderRadius: 12,
    backgroundColor: THEME.surface,
    borderWidth: 1,
    borderColor: THEME.orange,
    gap: 10,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  title: { color: THEME.textPrimary, fontSize: 14, fontWeight: "600" },
  hostBadgeLabel: {
    color: THEME.textSecondary,
    fontSize: 11,
    fontWeight: "500",
  },
  hostPill: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: 10,
    borderWidth: 1,
    maxWidth: "100%",
  },
  hostText: {
    color: THEME.textPrimary,
    fontWeight: "700",
    letterSpacing: -0.2,
  },
  punycodeTag: {
    color: THEME.red,
    fontSize: 11,
    fontWeight: "600",
  },
  agentNoteBox: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: THEME.toolbar,
    borderWidth: 1,
    borderColor: THEME.border,
    gap: 3,
  },
  agentNoteLabel: {
    color: THEME.textTertiary,
    fontSize: 11,
    fontWeight: "600",
  },
  agentNoteBody: { color: THEME.textPrimary, fontSize: 13, lineHeight: 18 },
  row: { flexDirection: "row", gap: 8, marginTop: 2 },
  primaryButton: {
    backgroundColor: THEME.blue,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 8,
  },
  primaryButtonText: { color: THEME.white, fontSize: 12, fontWeight: "600" },
  secondaryButton: {
    backgroundColor: THEME.inputBg,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 8,
  },
  secondaryButtonText: {
    color: THEME.textPrimary,
    fontSize: 12,
    fontWeight: "500",
  },
});
