import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import type { ConnectionConfig, ConnectionState } from "../types";

type SettingsPaneProps = {
  readonly config: ConnectionConfig;
  readonly connectionState: ConnectionState;
  readonly onSave: (config: ConnectionConfig) => void;
};

export function SettingsPane({
  config,
  connectionState,
  onSave,
}: SettingsPaneProps) {
  const [baseUrl, setBaseUrl] = useState(config.baseUrl);
  const [agentId, setAgentId] = useState(config.agentId);
  const [authToken, setAuthToken] = useState(config.authToken);

  return (
    <View style={styles.container}>
      <Text style={styles.heading}>Agent Connection</Text>
      <Text style={styles.status}>Status: {connectionState}</Text>

      <Text style={styles.label}>Worker Base URL</Text>
      <TextInput
        style={styles.input}
        value={baseUrl}
        onChangeText={setBaseUrl}
        placeholder="http://127.0.0.1:8787"
        placeholderTextColor="#6b7280"
      />

      <Text style={styles.label}>Agent ID</Text>
      <TextInput
        style={styles.input}
        value={agentId}
        onChangeText={setAgentId}
        placeholder="personal"
        placeholderTextColor="#6b7280"
      />

      <Text style={styles.label}>Bearer Auth Token</Text>
      <TextInput
        style={styles.input}
        value={authToken}
        onChangeText={setAuthToken}
        secureTextEntry
        placeholder="Optional AUTH_TOKEN"
        placeholderTextColor="#6b7280"
      />

      <Pressable
        style={styles.button}
        onPress={() =>
          onSave({
            baseUrl: baseUrl.trim(),
            agentId: agentId.trim() || "personal",
            authToken: authToken.trim(),
          })
        }
      >
        <Text style={styles.buttonText}>Save & Reconnect</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0f172a", padding: 16, gap: 10 },
  heading: { color: "#f8fafc", fontSize: 16, fontWeight: "700" },
  status: { color: "#93c5fd", fontSize: 13 },
  label: { color: "#cbd5e1", fontSize: 12, fontWeight: "600", marginTop: 6 },
  input: {
    backgroundColor: "#1e293b",
    color: "#f8fafc",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 13,
  },
  button: {
    backgroundColor: "#2563eb",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    alignSelf: "flex-start",
    marginTop: 8,
  },
  buttonText: { color: "#ffffff", fontSize: 13, fontWeight: "600" },
});
