import { useState } from "react";
import {
  Linking,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { validateBaseUrl } from "../agent-client";
import { isRecord } from "../protocol-parsers";
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
  const [validationError, setValidationError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const handleSave = () => {
    const validated = validateBaseUrl(baseUrl);
    if (!validated.ok) {
      setValidationError(validated.error);
      return;
    }
    setValidationError(null);
    onSave({
      baseUrl: validated.value,
      agentId: agentId.trim() || "personal",
      authToken: authToken.trim(),
    });
  };

  const handleSignIn = async () => {
    const validated = validateBaseUrl(baseUrl);
    if (!validated.ok) {
      setValidationError(validated.error);
      return;
    }
    setValidationError(null);
    setStatusMessage("Checking Cloudflare Access OAuth configuration...");
    try {
      const response = await fetch(`${validated.value}/auth/config`);
      if (!response.ok) {
        setStatusMessage(null);
        setValidationError(`HTTP ${response.status} loading /auth/config`);
        return;
      }
      const data: unknown = await response.json();
      if (
        !isRecord(data) ||
        data.provider !== "cloudflare_access_oauth" ||
        typeof data.teamDomain !== "string" ||
        typeof data.clientId !== "string"
      ) {
        setStatusMessage(null);
        setValidationError(
          "Cloudflare Access Managed OAuth is not configured on this Worker yet.",
        );
        return;
      }
      const origin = data.teamDomain.startsWith("https://")
        ? data.teamDomain.replace(/\/$/, "")
        : `https://${data.teamDomain.replace(/\/$/, "")}`;
      const params = new URLSearchParams({
        client_id: data.clientId,
        response_type: "code",
        redirect_uri: "piinthesky://auth/callback",
        scope: "openid email profile",
      });
      await Linking.openURL(
        `${origin}/cdn-cgi/access/sso/oauth2/auth?${params.toString()}`,
      );
      setStatusMessage("Opened system browser for Cloudflare Access sign-in.");
    } catch (thrown) {
      setStatusMessage(null);
      setValidationError(
        thrown instanceof Error ? thrown.message : String(thrown),
      );
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.heading}>Agent Connection</Text>
      <Text style={styles.status}>Status: {connectionState}</Text>

      <Text style={styles.label}>Worker Base URL</Text>
      <TextInput
        style={styles.input}
        value={baseUrl}
        onChangeText={setBaseUrl}
        placeholder="https://agent.example.com"
        placeholderTextColor="#6b7280"
      />

      <Pressable
        style={styles.oauthButton}
        onPress={() => {
          void handleSignIn();
        }}
      >
        <Text style={styles.buttonText}>Sign in with Cloudflare Access</Text>
      </Pressable>

      <Text style={styles.label}>Agent ID (local dev)</Text>
      <TextInput
        style={styles.input}
        value={agentId}
        onChangeText={setAgentId}
        placeholder="personal"
        placeholderTextColor="#6b7280"
      />

      <Text style={styles.label}>Access JWT or Local Dev Token</Text>
      <TextInput
        style={styles.input}
        value={authToken}
        onChangeText={setAuthToken}
        secureTextEntry
        placeholder="Cloudflare Access JWT or local AUTH_TOKEN"
        placeholderTextColor="#6b7280"
      />

      {statusMessage ? (
        <Text style={styles.status}>{statusMessage}</Text>
      ) : null}

      {validationError ? (
        <Text style={styles.error}>{validationError}</Text>
      ) : null}

      <Pressable style={styles.button} onPress={handleSave}>
        <Text style={styles.buttonText}>Save & Reconnect</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0f172a", padding: 16, gap: 10 },
  heading: { color: "#f8fafc", fontSize: 16, fontWeight: "700" },
  status: { color: "#93c5fd", fontSize: 13 },
  error: { color: "#fca5a5", fontSize: 12 },
  label: { color: "#cbd5e1", fontSize: 12, fontWeight: "600", marginTop: 6 },
  input: {
    backgroundColor: "#1e293b",
    color: "#f8fafc",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 13,
  },
  oauthButton: {
    backgroundColor: "#0f766e",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    alignSelf: "flex-start",
    marginTop: 4,
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
