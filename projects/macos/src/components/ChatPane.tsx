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

import type { ChatMessage, TakeoverItem } from "../types";

type ChatPaneProps = {
  readonly messages: readonly ChatMessage[];
  readonly activeTakeovers: readonly TakeoverItem[];
  readonly onSend: (text: string) => boolean;
  readonly onAbort: () => void;
  readonly onResumeTakeover: (id: string) => void;
};

export function ChatPane({
  messages,
  activeTakeovers,
  onSend,
  onAbort,
  onResumeTakeover,
}: ChatPaneProps) {
  const [draft, setDraft] = useState("");

  const handleSend = () => {
    const trimmed = draft.trim();
    if (!trimmed) {
      return;
    }
    if (onSend(trimmed)) {
      setDraft("");
    }
  };

  return (
    <View style={styles.container}>
      <ScrollView style={styles.transcript} contentContainerStyle={styles.list}>
        {messages.length === 0 ? (
          <Text style={styles.empty}>
            Ask your personal agent to triage email, research flights, or fill
            out forms.
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
          <View key={takeover.id} style={styles.actionCard}>
            <Text style={styles.cardTitle}>Browser Takeover Needed</Text>
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

      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          placeholder="Message your agent..."
          placeholderTextColor="#6b7280"
          onSubmitEditing={handleSend}
        />
        <Pressable style={styles.sendButton} onPress={handleSend}>
          <Text style={styles.buttonText}>Send</Text>
        </Pressable>
        <Pressable style={styles.stopButton} onPress={onAbort}>
          <Text style={styles.buttonText}>Stop</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0f172a" },
  transcript: { flex: 1 },
  list: { padding: 16, gap: 12 },
  empty: { color: "#94a3b8", fontSize: 14, marginTop: 24 },
  bubble: { padding: 12, borderRadius: 10, maxWidth: "85%" },
  userBubble: { alignSelf: "flex-end", backgroundColor: "#1d4ed8" },
  assistantBubble: { alignSelf: "flex-start", backgroundColor: "#1e293b" },
  role: { color: "#cbd5e1", fontSize: 10, fontWeight: "700", marginBottom: 4 },
  body: { color: "#f8fafc", fontSize: 14, lineHeight: 20 },
  subtle: { color: "#94a3b8", fontSize: 12, marginTop: 4 },
  actionCard: {
    padding: 14,
    borderRadius: 10,
    backgroundColor: "#1e293b",
    borderWidth: 1,
    borderColor: "#f59e0b",
    gap: 6,
  },
  cardTitle: { color: "#fbbf24", fontSize: 13, fontWeight: "700" },
  row: { flexDirection: "row", gap: 8, marginTop: 8 },
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
  },
  buttonText: { color: "#ffffff", fontSize: 13, fontWeight: "600" },
});
