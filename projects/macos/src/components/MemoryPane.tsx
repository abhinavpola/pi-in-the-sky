import type { AgentClient } from "@pi-in-the-sky/client/agent-client";
import type { MemoryNote, ProfileEntry } from "@pi-in-the-sky/client/protocol";
import { useCallback, useEffect, useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { THEME } from "../theme";

type MemoryPaneProps = {
  readonly client: AgentClient;
};

export function MemoryPane({ client }: MemoryPaneProps) {
  const [profile, setProfile] = useState<ProfileEntry[]>([]);
  const [notes, setNotes] = useState<MemoryNote[]>([]);
  const [profileKey, setProfileKey] = useState("");
  const [profileValue, setProfileValue] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [noteDraft, setNoteDraft] = useState("");
  const [errorText, setErrorText] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [profileRes, notesRes] = await Promise.all([
      client.getProfile(),
      client.searchNotes(searchQuery),
    ]);
    if (profileRes.ok) {
      setProfile(profileRes.value.entries);
    } else {
      setErrorText(profileRes.error);
    }
    if (notesRes.ok) {
      setNotes(notesRes.value.notes);
    } else {
      setErrorText(notesRes.error);
    }
  }, [client, searchQuery]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleSaveProfile = async () => {
    if (!profileKey.trim() || !profileValue.trim()) {
      return;
    }
    setErrorText(null);
    const res = await client.setProfileEntry(
      profileKey.trim(),
      profileValue.trim(),
    );
    if (!res.ok) {
      setErrorText(res.error);
      return;
    }
    setProfileKey("");
    setProfileValue("");
    await refresh();
  };

  const handleAddNote = async () => {
    if (!noteDraft.trim()) {
      return;
    }
    setErrorText(null);
    const res = await client.addNote(noteDraft.trim());
    if (!res.ok) {
      setErrorText(res.error);
      return;
    }
    setNoteDraft("");
    await refresh();
  };

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.contentWrap}
    >
      <View style={styles.column}>
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Preferences</Text>
          <View style={styles.card}>
            <View style={styles.inputRow}>
              <TextInput
                style={styles.input}
                value={profileKey}
                onChangeText={setProfileKey}
                placeholder="Name"
                placeholderTextColor={THEME.textTertiary}
              />
              <TextInput
                style={styles.input}
                value={profileValue}
                onChangeText={setProfileValue}
                placeholder="Value"
                placeholderTextColor={THEME.textTertiary}
                onSubmitEditing={() => {
                  void handleSaveProfile();
                }}
              />
              <Pressable
                style={styles.primaryButton}
                onPress={() => {
                  void handleSaveProfile();
                }}
              >
                <Text style={styles.primaryButtonText}>Add</Text>
              </Pressable>
            </View>

            {profile.map((entry) => (
              <View key={entry.key} style={styles.listRow}>
                <Text style={styles.rowLabel}>{entry.key}</Text>
                <Text style={styles.rowValue}>{entry.value}</Text>
              </View>
            ))}
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Notes</Text>
          <View style={styles.card}>
            <View style={styles.inputRow}>
              <TextInput
                style={styles.input}
                value={searchQuery}
                onChangeText={setSearchQuery}
                placeholder="Search notes"
                placeholderTextColor={THEME.textTertiary}
                onSubmitEditing={() => {
                  void refresh();
                }}
              />
              <Pressable
                style={styles.secondaryButton}
                onPress={() => {
                  void refresh();
                }}
              >
                <Text style={styles.secondaryButtonText}>Search</Text>
              </Pressable>
            </View>

            <View style={styles.inputRow}>
              <TextInput
                style={styles.input}
                value={noteDraft}
                onChangeText={setNoteDraft}
                placeholder="New note"
                placeholderTextColor={THEME.textTertiary}
                onSubmitEditing={() => {
                  void handleAddNote();
                }}
              />
              <Pressable
                style={styles.primaryButton}
                onPress={() => {
                  void handleAddNote();
                }}
              >
                <Text style={styles.primaryButtonText}>Save</Text>
              </Pressable>
            </View>

            {notes.map((note) => (
              <View key={note.id} style={styles.noteRow}>
                <Text style={styles.noteDate}>{note.date}</Text>
                <Text style={styles.rowValue}>{note.content}</Text>
              </View>
            ))}
          </View>
        </View>

        {errorText ? <Text style={styles.error}>{errorText}</Text> : null}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: THEME.canvas },
  contentWrap: { padding: 28, alignItems: "center" },
  column: { width: "100%", maxWidth: 640, gap: 24 },
  section: { gap: 8 },
  sectionTitle: {
    color: THEME.textSecondary,
    fontSize: 12,
    fontWeight: "600",
    paddingHorizontal: 4,
  },
  card: {
    backgroundColor: THEME.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: THEME.border,
    padding: 14,
    gap: 10,
  },
  inputRow: { flexDirection: "row", gap: 8, alignItems: "center" },
  input: {
    flex: 1,
    backgroundColor: THEME.inputBg,
    color: THEME.textPrimary,
    borderRadius: 8,
    paddingHorizontal: 11,
    paddingVertical: 8,
    fontSize: 13,
  },
  primaryButton: {
    backgroundColor: THEME.blue,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
  },
  primaryButtonText: { color: THEME.white, fontSize: 12, fontWeight: "600" },
  secondaryButton: {
    backgroundColor: THEME.inputBg,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
  },
  secondaryButtonText: {
    color: THEME.textPrimary,
    fontSize: 12,
    fontWeight: "500",
  },
  listRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: THEME.border,
  },
  noteRow: {
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: THEME.border,
    gap: 3,
  },
  rowLabel: { color: THEME.textSecondary, fontSize: 13, fontWeight: "500" },
  rowValue: { color: THEME.textPrimary, fontSize: 13, lineHeight: 18 },
  noteDate: { color: THEME.textTertiary, fontSize: 11 },
  error: { color: THEME.red, fontSize: 12 },
});
