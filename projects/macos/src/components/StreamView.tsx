import type {
  ActivityRecord,
  ChatMessage,
  TakeoverRecord,
} from "@pi-in-the-sky/client/protocol";
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

import { THEME } from "../theme";

type StreamViewProps = {
  readonly messages: readonly ChatMessage[];
  readonly activities: readonly ActivityRecord[];
  readonly activeTakeovers: readonly TakeoverRecord[];
  readonly showDrawer: boolean;
  readonly onSend: (text: string) => boolean;
  readonly onSteerActivity: (
    activityId: string,
    instruction: string,
  ) => boolean;
  readonly onToggleActivity: (activityId: string, collapsed: boolean) => void;
  readonly onAbort: () => void;
  readonly onResumeTakeover: (id: string) => void;
};

function activityDotColor(status: ActivityRecord["status"]): string {
  switch (status) {
    case "running":
      return THEME.blue;
    case "waiting_input":
      return THEME.orange;
    case "completed":
      return THEME.green;
    case "failed":
      return THEME.red;
    case "cancelled":
      return THEME.textTertiary;
    default: {
      status satisfies never;
      return THEME.textTertiary;
    }
  }
}

function activityStatusLabel(status: ActivityRecord["status"]): string {
  switch (status) {
    case "running":
      return "Running";
    case "waiting_input":
      return "Needs input";
    case "completed":
      return "Done";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    default: {
      status satisfies never;
      return "";
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
          contentContainerStyle={styles.listContent}
        >
          <View style={styles.readingColumn}>
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
                        <View
                          style={[
                            styles.dot,
                            {
                              backgroundColor: activityDotColor(
                                activity.status,
                              ),
                            },
                          ]}
                        />
                        <Text style={styles.cardTitle}>{activity.title}</Text>
                        <Text style={styles.subtle}>
                          {activityStatusLabel(activity.status)}
                        </Text>
                      </Pressable>
                      <Pressable
                        style={styles.replyChip}
                        onPress={() => setTargetActivityId(activity.id)}
                      >
                        <Text style={styles.replyChipText}>Reply</Text>
                      </Pressable>
                    </View>
                    {activity.collapsed ? null : (
                      <Text style={styles.activityBody}>
                        {activity.summary}
                      </Text>
                    )}
                  </View>
                ))}
              </View>
            ) : null}

            {messages.length === 0 ? (
              <View style={styles.emptyWrap}>
                <Text style={styles.emptyTitle}>What can I help with?</Text>
              </View>
            ) : (
              messages.map((message) => {
                const isUser = message.role === "user";
                return (
                  <View
                    key={message.id}
                    style={[
                      styles.bubble,
                      isUser ? styles.userBubble : styles.assistantBubble,
                    ]}
                  >
                    <Text
                      style={[
                        styles.body,
                        isUser ? styles.userBody : styles.assistantBody,
                      ]}
                    >
                      {message.text}
                    </Text>
                  </View>
                );
              })
            )}

            {activeTakeovers.map((takeover) => (
              <View key={takeover.id} style={styles.takeoverCard}>
                <Text style={styles.takeoverTitle}>Action needed</Text>
                <Text style={styles.assistantBody}>{takeover.reason}</Text>
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
                      <Text style={styles.secondaryButtonText}>Open</Text>
                    </Pressable>
                  ) : null}
                  <Pressable
                    style={styles.primaryButton}
                    onPress={() => onResumeTakeover(takeover.id)}
                  >
                    <Text style={styles.primaryButtonText}>Done</Text>
                  </Pressable>
                </View>
              </View>
            ))}
          </View>
        </ScrollView>

        <View style={styles.composerWrap}>
          <View style={styles.composerInner}>
            {targetActivity ? (
              <View style={styles.replyBanner}>
                <Text style={styles.replyLabel}>
                  Replying to {targetActivity.title}
                </Text>
                <Pressable onPress={() => setTargetActivityId(null)}>
                  <Text style={styles.clearLink}>Cancel</Text>
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
                    ? `Reply to ${targetActivity.title}`
                    : "Message"
                }
                placeholderTextColor={THEME.textTertiary}
                onSubmitEditing={handleSend}
              />
              <Pressable style={styles.stopButton} onPress={onAbort}>
                <Text style={styles.stopButtonText}>Stop</Text>
              </Pressable>
              <Pressable style={styles.sendButton} onPress={handleSend}>
                <Text style={styles.sendButtonText}>Send</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </View>

      {showDrawer ? (
        <View style={styles.drawer}>
          <Text style={styles.drawerHeading}>Tasks</Text>
          <ScrollView contentContainerStyle={styles.drawerList}>
            {activities.length === 0 ? (
              <Text style={styles.subtle}>No tasks yet</Text>
            ) : (
              activities.map((activity) => (
                <Pressable
                  key={activity.id}
                  style={styles.drawerItem}
                  onPress={() => setTargetActivityId(activity.id)}
                >
                  <View style={styles.cardTitleRow}>
                    <View
                      style={[
                        styles.dot,
                        { backgroundColor: activityDotColor(activity.status) },
                      ]}
                    />
                    <Text style={styles.cardTitle}>{activity.title}</Text>
                  </View>
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
  root: { flex: 1, flexDirection: "row", backgroundColor: THEME.canvas },
  streamColumn: { flex: 1 },
  transcript: { flex: 1 },
  listContent: {
    flexGrow: 1,
    paddingHorizontal: 24,
    paddingVertical: 24,
    alignItems: "center",
  },
  readingColumn: {
    width: "100%",
    maxWidth: 720,
    flexGrow: 1,
    gap: 12,
  },
  emptyWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 120,
  },
  emptyTitle: {
    color: THEME.textTertiary,
    fontSize: 18,
    fontWeight: "500",
    letterSpacing: -0.2,
  },
  activityStrip: { gap: 8, marginBottom: 4 },
  activityCard: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: THEME.surface,
    borderWidth: 1,
    borderColor: THEME.border,
    gap: 6,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  cardTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flex: 1,
  },
  dot: { width: 7, height: 7, borderRadius: 4 },
  cardTitle: { color: THEME.textPrimary, fontSize: 13, fontWeight: "600" },
  activityBody: { color: THEME.textSecondary, fontSize: 13, lineHeight: 19 },
  replyChip: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: THEME.inputBg,
  },
  replyChipText: { color: THEME.textPrimary, fontSize: 11, fontWeight: "500" },
  bubble: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 16,
    maxWidth: "82%",
  },
  userBubble: {
    alignSelf: "flex-end",
    backgroundColor: THEME.blue,
  },
  assistantBubble: {
    alignSelf: "flex-start",
    backgroundColor: THEME.surface,
    borderWidth: 1,
    borderColor: THEME.border,
  },
  body: { fontSize: 14, lineHeight: 20 },
  userBody: { color: THEME.white },
  assistantBody: { color: THEME.textPrimary },
  subtle: { color: THEME.textSecondary, fontSize: 12 },
  takeoverCard: {
    padding: 16,
    borderRadius: 12,
    backgroundColor: THEME.surface,
    borderWidth: 1,
    borderColor: THEME.orange,
    gap: 8,
  },
  takeoverTitle: { color: THEME.textPrimary, fontSize: 14, fontWeight: "600" },
  row: { flexDirection: "row", gap: 8, marginTop: 4 },
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
  composerWrap: {
    paddingHorizontal: 24,
    paddingVertical: 14,
    borderTopWidth: 1,
    borderTopColor: THEME.border,
    backgroundColor: THEME.toolbar,
    alignItems: "center",
  },
  composerInner: {
    width: "100%",
    maxWidth: 720,
    gap: 8,
  },
  replyBanner: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: THEME.blueTint,
  },
  replyLabel: { color: THEME.blue, fontSize: 12, fontWeight: "500" },
  clearLink: { color: THEME.textSecondary, fontSize: 12, fontWeight: "500" },
  composer: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: THEME.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: THEME.borderStrong,
    paddingLeft: 14,
    paddingRight: 6,
    paddingVertical: 6,
  },
  input: {
    flex: 1,
    color: THEME.textPrimary,
    fontSize: 14,
    paddingVertical: 4,
  },
  sendButton: {
    backgroundColor: THEME.blue,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 8,
  },
  sendButtonText: { color: THEME.white, fontSize: 13, fontWeight: "600" },
  stopButton: {
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 8,
  },
  stopButtonText: {
    color: THEME.textSecondary,
    fontSize: 12,
    fontWeight: "500",
  },
  drawer: {
    width: 280,
    borderLeftWidth: 1,
    borderLeftColor: THEME.border,
    backgroundColor: THEME.toolbar,
    padding: 16,
    gap: 12,
  },
  drawerHeading: {
    color: THEME.textPrimary,
    fontSize: 13,
    fontWeight: "600",
  },
  drawerList: { gap: 8 },
  drawerItem: {
    padding: 12,
    borderRadius: 10,
    backgroundColor: THEME.surface,
    borderWidth: 1,
    borderColor: THEME.border,
    gap: 4,
  },
});
