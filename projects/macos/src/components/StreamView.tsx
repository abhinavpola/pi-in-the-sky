import { useState } from "react";
import {
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import type { ActivityItem, ChatMessage, TakeoverItem } from "../types";

type StreamViewProps = {
  readonly messages: readonly ChatMessage[];
  readonly activities: readonly ActivityItem[];
  readonly activeTakeovers: readonly TakeoverItem[];
  readonly showDrawer: boolean;
  readonly onSend: (text: string) => boolean;
  readonly onSteerActivity: (
    activityId: string,
    instruction: string,
  ) => boolean;
  readonly onToggleActivity: (activityId: string, collapsed: boolean) => void;
  readonly onCompact: () => void;
  readonly onAbort: () => void;
  readonly onResumeTakeover: (id: string) => void;
};

function statusBadgeLabel(status: ActivityItem["status"]): string {
  switch (status) {
    case "running":
      return "RUNNING";
    case "waiting_input":
      return "NEEDS INPUT";
    case "completed":
      return "DONE";
    case "failed":
      return "FAILED";
    case "cancelled":
      return "CANCELLED";
    default: {
      status satisfies never;
      return "UNKNOWN";
    }
  }
}

export function StreamView({
  messages,
  activities,
  activeTakeovers,
  showDrawer,
  onSend,
  onSteerActivity,
  onToggleActivity,
  onCompact,
  onAbort,
  onResumeTakeover,
}: StreamViewProps) {
  const [draft, setDraft] = useState("");
  const [targetActivityId, setTargetActivityId] = useState<string | null>(null);

  const targetActivity = targetActivityId
    ? (activities.find((item) => item.id === targetActivityId) ?? null)
    : null;

  const handleSend = () => {
    const trimmed = draft.trim();
    if (!trimmed) {
      return;
    }
    const sent = targetActivity
      ? onSteerActivity(targetActivity.id, trimmed)
      : onSend(trimmed);
    if (sent) {
      setDraft("");
      if (targetActivity) {
        setTargetActivityId(null);
      }
    }
  };

  return (
    <View style={styles.root}>
      <View style={styles.streamColumn}>
        <ScrollView
          style={styles.transcript}
          contentContainerStyle={styles.list}
        >
          {activities.length > 0 ? (
            <View style={styles.activityStrip}>
              {activities.map((activity) => (
                <View key={activity.id} style={styles.activityCard}>
                  <View style={styles.cardHeader}>
                    <Pressable
                      style={styles.cardTitleRow}
                      onPress={() =>
                        onToggleActivity(activity.id, !activity.collapsed)
                      }
                    >
                      <Text style={styles.statusPill}>
                        {statusBadgeLabel(activity.status)}
                      </Text>
                      <Text style={styles.cardTitle}>{activity.title}</Text>
                      <Text style={styles.subtle}>
                        {activity.collapsed ? "Show" : "Collapse"}
                      </Text>
                    </Pressable>
                    <Pressable
                      style={styles.replyChip}
                      onPress={() => setTargetActivityId(activity.id)}
                    >
                      <Text style={styles.chipText}>Reply</Text>
                    </Pressable>
                  </View>
                  {activity.collapsed ? null : (
                    <Text style={styles.body}>{activity.summary}</Text>
                  )}
                </View>
              ))}
            </View>
          ) : null}

          {messages.length === 0 ? (
            <Text style={styles.empty}>
              Talk to your agent directly. Multi-step work spins up as
              collapsible Activity cards while this stream stays open.
            </Text>
          ) : (
            messages.map((message) => (
              <View
                key={message.id}
                style={[
                  styles.bubble,
                  message.role === "user"
                    ? styles.userBubble
                    : styles.assistantBubble,
                ]}
              >
                <Text style={styles.role}>{message.role.toUpperCase()}</Text>
                <Text style={styles.body}>{message.text}</Text>
              </View>
            ))
          )}

          {activeTakeovers.map((takeover) => (
            <View key={takeover.id} style={styles.takeoverCard}>
              <Text style={styles.takeoverTitle}>Browser Takeover Needed</Text>
              <Text style={styles.body}>{takeover.reason}</Text>
              <Text style={styles.subtle}>{takeover.url}</Text>
              <View style={styles.row}>
                {takeover.liveViewUrl ? (
                  <Pressable
                    style={styles.secondaryButton}
                    onPress={() => {
                      if (takeover.liveViewUrl) {
                        void Linking.openURL(takeover.liveViewUrl);
                      }
                    }}
                  >
                    <Text style={styles.buttonText}>Open Live View</Text>
                  </Pressable>
                ) : null}
                <Pressable
                  style={styles.resumeButton}
                  onPress={() => onResumeTakeover(takeover.id)}
                >
                  <Text style={styles.buttonText}>Resume Agent</Text>
                </Pressable>
              </View>
            </View>
          ))}
        </ScrollView>

        {targetActivity ? (
          <View style={styles.replyBanner}>
            <Text style={styles.replyLabel}>
              Replying to activity: {targetActivity.title}
            </Text>
            <Pressable onPress={() => setTargetActivityId(null)}>
              <Text style={styles.clearLink}>Clear</Text>
            </Pressable>
          </View>
        ) : null}

        <View style={styles.composer}>
          <TextInput
            style={styles.input}
            value={draft}
            onChangeText={setDraft}
            placeholder={
              targetActivity
                ? `Steer "${targetActivity.title}"...`
                : "Message your agent..."
            }
            placeholderTextColor="#6b7280"
            onSubmitEditing={handleSend}
          />
          <Pressable style={styles.sendButton} onPress={handleSend}>
            <Text style={styles.buttonText}>Send</Text>
          </Pressable>
          <Pressable style={styles.secondaryButton} onPress={onCompact}>
            <Text style={styles.buttonText}>Compact</Text>
          </Pressable>
          <Pressable style={styles.stopButton} onPress={onAbort}>
            <Text style={styles.buttonText}>Stop</Text>
          </Pressable>
        </View>
      </View>

      {showDrawer ? (
        <View style={styles.drawer}>
          <Text style={styles.drawerHeading}>Activities</Text>
          <ScrollView contentContainerStyle={styles.drawerList}>
            {activities.length === 0 ? (
              <Text style={styles.subtle}>No active or past activities.</Text>
            ) : (
              activities.map((activity) => (
                <Pressable
                  key={activity.id}
                  style={styles.drawerItem}
                  onPress={() => setTargetActivityId(activity.id)}
                >
                  <Text style={styles.statusPill}>
                    {statusBadgeLabel(activity.status)}
                  </Text>
                  <Text style={styles.cardTitle}>{activity.title}</Text>
                  <Text style={styles.subtle}>{activity.summary}</Text>
                </Pressable>
              ))
            )}
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, flexDirection: "row", backgroundColor: "#0f172a" },
  streamColumn: { flex: 1 },
  transcript: { flex: 1 },
  list: { padding: 16, gap: 12 },
  activityStrip: { gap: 8 },
  activityCard: {
    padding: 12,
    borderRadius: 10,
    backgroundColor: "#172033",
    borderWidth: 1,
    borderColor: "#334155",
    gap: 6,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  cardTitleRow: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  statusPill: {
    color: "#38bdf8",
    fontSize: 10,
    fontWeight: "700",
  },
  cardTitle: { color: "#f8fafc", fontSize: 13, fontWeight: "700" },
  replyChip: {
    backgroundColor: "#1e3a8a",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
  },
  chipText: { color: "#dbeafe", fontSize: 11, fontWeight: "600" },
  empty: { color: "#94a3b8", fontSize: 14, marginTop: 24 },
  bubble: { padding: 12, borderRadius: 10, maxWidth: "85%" },
  userBubble: { alignSelf: "flex-end", backgroundColor: "#1d4ed8" },
  assistantBubble: { alignSelf: "flex-start", backgroundColor: "#1e293b" },
  role: { color: "#cbd5e1", fontSize: 10, fontWeight: "700", marginBottom: 4 },
  body: { color: "#f8fafc", fontSize: 14, lineHeight: 20 },
  subtle: { color: "#94a3b8", fontSize: 12 },
  takeoverCard: {
    padding: 14,
    borderRadius: 10,
    backgroundColor: "#1e293b",
    borderWidth: 1,
    borderColor: "#f59e0b",
    gap: 6,
  },
  takeoverTitle: { color: "#fbbf24", fontSize: 13, fontWeight: "700" },
  row: { flexDirection: "row", gap: 8, marginTop: 8 },
  replyBanner: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingVertical: 6,
    backgroundColor: "#172554",
  },
  replyLabel: { color: "#bfdbfe", fontSize: 12, fontWeight: "600" },
  clearLink: { color: "#93c5fd", fontSize: 12, fontWeight: "700" },
  composer: {
    flexDirection: "row",
    padding: 12,
    gap: 8,
    borderTopWidth: 1,
    borderTopColor: "#1e293b",
    backgroundColor: "#0b1120",
  },
  input: {
    flex: 1,
    backgroundColor: "#1e293b",
    color: "#f8fafc",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 14,
  },
  sendButton: {
    backgroundColor: "#2563eb",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    justifyContent: "center",
  },
  resumeButton: {
    backgroundColor: "#16a34a",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  stopButton: {
    backgroundColor: "#dc2626",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    justifyContent: "center",
  },
  secondaryButton: {
    backgroundColor: "#475569",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    justifyContent: "center",
  },
  buttonText: { color: "#ffffff", fontSize: 13, fontWeight: "600" },
  drawer: {
    width: 260,
    borderLeftWidth: 1,
    borderLeftColor: "#1e293b",
    backgroundColor: "#0b1120",
    padding: 14,
    gap: 10,
  },
  drawerHeading: { color: "#f8fafc", fontSize: 14, fontWeight: "700" },
  drawerList: { gap: 10 },
  drawerItem: {
    padding: 10,
    borderRadius: 8,
    backgroundColor: "#172033",
    gap: 4,
  },
});
