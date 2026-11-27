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
  const [statusMessage, setStatusMessage] = useState("");

  const refresh = useCallback(async () => {
    const [profileRes, notesRes] = await Promise.all([
      client.getProfile(),
      client.searchNotes(searchQuery),
    ]);
    if (profileRes.ok) {
      setProfile(profileRes.value.entries);
    } else {
      setStatusMessage(profileRes.error);
    }
    if (notesRes.ok) {
      setNotes(notesRes.value.notes);
    } else {
      setStatusMessage(notesRes.error);
    }
  }, [client, searchQuery]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleSaveProfile = async () => {
    if (!profileKey.trim() || !profileValue.trim()) {
      return;
    }
    const res = await client.setProfileEntry(
      profileKey.trim(),
      profileValue.trim(),
    );
    if (!res.ok) {
      setStatusMessage(res.error);
      return;
    }
    setProfileKey("");
    setProfileValue("");
    setStatusMessage("Profile updated.");
    await refresh();
  };

  const handleAddNote = async () => {
    if (!noteDraft.trim()) {
      return;
    }
    const res = await client.addNote(noteDraft.trim());
    if (!res.ok) {
      setStatusMessage(res.error);
      return;
    }
    setNoteDraft("");
    setStatusMessage("Note saved.");
    await refresh();
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.heading}>Standing Profile</Text>
      <View style={styles.row}>
        <TextInput
          style={styles.input}
          value={profileKey}
          onChangeText={setProfileKey}
          placeholder="key (e.g. home_airport)"
          placeholderTextColor="#6b7280"
        />
        <TextInput
          style={styles.input}
          value={profileValue}
          onChangeText={setProfileValue}
          placeholder="value (e.g. SFO)"
          placeholderTextColor="#6b7280"
        />
        <Pressable
          style={styles.button}
          onPress={() => void handleSaveProfile()}
        >
          <Text style={styles.buttonText}>Save</Text>
        </Pressable>
      </View>

      {profile.map((entry) => (
        <View key={entry.key} style={styles.item}>
          <Text style={styles.itemKey}>{entry.key}</Text>
          <Text style={styles.itemValue}>{entry.value}</Text>
        </View>
      ))}

      <Text style={styles.heading}>Searchable Notes (SQLite FTS5)</Text>
      <View style={styles.row}>
        <TextInput
          style={styles.input}
          value={searchQuery}
          onChangeText={setSearchQuery}
          placeholder="Search notes..."
          placeholderTextColor="#6b7280"
        />
        <Pressable style={styles.button} onPress={() => void refresh()}>
          <Text style={styles.buttonText}>Search</Text>
        </Pressable>
      </View>

      <View style={styles.row}>
        <TextInput
          style={styles.input}
          value={noteDraft}
          onChangeText={setNoteDraft}
          placeholder="Add a dated memory note..."
          placeholderTextColor="#6b7280"
        />
        <Pressable style={styles.button} onPress={() => void handleAddNote()}>
          <Text style={styles.buttonText}>Add</Text>
        </Pressable>
      </View>

      {notes.map((note) => (
        <View key={note.id} style={styles.item}>
          <Text style={styles.itemKey}>
            {note.date} · {note.category}
          </Text>
          <Text style={styles.itemValue}>{note.content}</Text>
        </View>
      ))}

      {statusMessage ? (
        <Text style={styles.status}>{statusMessage}</Text>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0f172a" },
  content: { padding: 16, gap: 12 },
  heading: { color: "#f8fafc", fontSize: 16, fontWeight: "700", marginTop: 8 },
  row: { flexDirection: "row", gap: 8 },
  input: {
    flex: 1,
    backgroundColor: "#1e293b",
    color: "#f8fafc",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
  },
  button: {
    backgroundColor: "#2563eb",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    justifyContent: "center",
  },
  buttonText: { color: "#ffffff", fontSize: 13, fontWeight: "600" },
  item: {
    backgroundColor: "#1e293b",
    padding: 10,
    borderRadius: 8,
    gap: 4,
  },
  itemKey: { color: "#93c5fd", fontSize: 12, fontWeight: "600" },
  itemValue: { color: "#f8fafc", fontSize: 13 },
  status: { color: "#fbbf24", fontSize: 12, marginTop: 8 },
});
