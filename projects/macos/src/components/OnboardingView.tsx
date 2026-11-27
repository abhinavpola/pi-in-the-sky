import type { ConnectionConfig } from "@pi-in-the-sky/client/agent-client";
import {
  DEPLOY_TO_CLOUDFLARE_URL,
  discoverCloudflareWorker,
  fetchWorkerStatus,
  provisionWorkerSecrets,
} from "@pi-in-the-sky/client/onboarding";
import { LOCAL_DEV_AUTH_TOKEN } from "@pi-in-the-sky/client/protocol";
import { useState } from "react";
import {
  Linking,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { signInWithCloudflareAccess } from "../native";
import { THEME } from "../theme";

type OnboardingStep = "connect" | "deploy" | "access_login";

const LOCAL_DEV_URL = "http://127.0.0.1:8787";

type OnboardingViewProps = {
  readonly onComplete: (config: ConnectionConfig) => void;
};

export function OnboardingView({ onComplete }: OnboardingViewProps) {
  const [step, setStep] = useState<OnboardingStep>("connect");
  const [cfApiToken, setCfApiToken] = useState("");
  const [nearAiApiKey, setNearAiApiKey] = useState("");
  const [workerUrl, setWorkerUrl] = useState("");
  const [teamDomain, setTeamDomain] = useState("");
  const [clientId, setClientId] = useState("");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);

  const verifyLiveWorker = async (
    candidateUrl: string,
    fallbackToDeploy: boolean,
  ) => {
    setStatusMessage("Connecting...");
    const status = await fetchWorkerStatus(candidateUrl);
    switch (status.kind) {
      case "offline":
        setStatusMessage(null);
        setErrorText(status.reason);
        if (fallbackToDeploy) {
          setStep("deploy");
        }
        return;
      case "live_no_oauth":
        setStatusMessage(null);
        onComplete({
          baseUrl: status.baseUrl,
          authToken: LOCAL_DEV_AUTH_TOKEN,
        });
        return;
      case "live_oauth_ready":
        setWorkerUrl(status.baseUrl);
        setTeamDomain(status.teamDomain);
        setClientId(status.clientId);
        setStatusMessage(null);
        setStep("access_login");
        return;
      default: {
        status satisfies never;
      }
    }
  };

  const handleContinue = async () => {
    if (!cfApiToken.trim() || !nearAiApiKey.trim()) {
      setErrorText("Enter both keys to continue.");
      return;
    }
    setErrorText(null);
    setStatusMessage("Checking Cloudflare...");
    const discovery = await discoverCloudflareWorker(cfApiToken);
    switch (discovery.kind) {
      case "found": {
        setStatusMessage("Configuring...");
        const provisioned = await provisionWorkerSecrets(
          cfApiToken,
          discovery.accountId,
          nearAiApiKey,
        );
        if (!provisioned.ok) {
          setStatusMessage(null);
          setErrorText(provisioned.error);
          return;
        }
        setCfApiToken("");
        setNearAiApiKey("");
        setWorkerUrl(discovery.baseUrl);
        await verifyLiveWorker(discovery.baseUrl, true);
        return;
      }
      case "not_deployed":
        setStatusMessage(null);
        setStep("deploy");
        return;
      case "error":
        setStatusMessage(null);
        setErrorText(discovery.message);
        return;
      default: {
        discovery satisfies never;
      }
    }
  };

  const handleOpenDeploy = async () => {
    setErrorText(null);
    await Linking.openURL(DEPLOY_TO_CLOUDFLARE_URL);
  };

  const handleAccessLogin = async () => {
    setErrorText(null);
    const result = await signInWithCloudflareAccess({
      baseUrl: workerUrl,
      teamDomain,
      clientId,
      onStatus: setStatusMessage,
    });
    if (!result.ok) {
      setStatusMessage(null);
      setErrorText(result.error);
      return;
    }
    setStatusMessage(null);
    onComplete(result.value);
  };

  const renderStep = (current: OnboardingStep) => {
    switch (current) {
      case "connect":
        return (
          <View style={styles.card}>
            <View style={styles.field}>
              <Text style={styles.label}>Cloudflare Token</Text>
              <TextInput
                style={styles.input}
                value={cfApiToken}
                onChangeText={setCfApiToken}
                secureTextEntry
                placeholder="Paste token"
                placeholderTextColor={THEME.textTertiary}
              />
            </View>
            <View style={styles.field}>
              <Text style={styles.label}>NEAR AI Key</Text>
              <TextInput
                style={styles.input}
                value={nearAiApiKey}
                onChangeText={setNearAiApiKey}
                secureTextEntry
                placeholder="sk-..."
                placeholderTextColor={THEME.textTertiary}
              />
            </View>
            <Pressable
              style={styles.primaryButton}
              onPress={() => {
                void handleContinue();
              }}
            >
              <Text style={styles.primaryButtonText}>Continue</Text>
            </Pressable>
          </View>
        );
      case "deploy":
        return (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Deploy to Cloudflare</Text>
            <Text style={styles.cardBody}>
              Finish deploying in your browser, then continue.
            </Text>
            <Pressable
              style={styles.primaryButton}
              onPress={() => {
                void handleOpenDeploy();
              }}
            >
              <Text style={styles.primaryButtonText}>Deploy to Cloudflare</Text>
            </Pressable>
            <Pressable
              style={styles.secondaryButton}
              onPress={() => {
                void handleContinue();
              }}
            >
              <Text style={styles.secondaryButtonText}>Continue</Text>
            </Pressable>
            <Pressable
              style={styles.localLink}
              onPress={() => {
                setErrorText(null);
                setStep("connect");
              }}
            >
              <Text style={styles.localText}>Back</Text>
            </Pressable>
          </View>
        );
      case "access_login":
        return (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Sign In</Text>
            <Text style={styles.cardBody}>{teamDomain}</Text>
            <Pressable
              style={styles.primaryButton}
              onPress={() => {
                void handleAccessLogin();
              }}
            >
              <Text style={styles.primaryButtonText}>
                Sign in with Cloudflare
              </Text>
            </Pressable>
          </View>
        );
      default: {
        current satisfies never;
        return null;
      }
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.frame}>
        <View style={styles.header}>
          <Text style={styles.title}>Pi in the Sky</Text>
          <Text style={styles.subtitle}>Set up your personal assistant</Text>
        </View>

        {renderStep(step)}

        {statusMessage ? (
          <Text style={styles.status}>{statusMessage}</Text>
        ) : null}
        {errorText ? <Text style={styles.error}>{errorText}</Text> : null}

        <Pressable
          style={styles.localLink}
          onPress={() => {
            void verifyLiveWorker(LOCAL_DEV_URL, false);
          }}
        >
          <Text style={styles.localText}>Use local server</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: THEME.canvas,
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
  },
  frame: {
    width: "100%",
    maxWidth: 380,
    gap: 16,
  },
  header: {
    alignItems: "center",
    gap: 4,
    marginBottom: 4,
  },
  title: {
    color: THEME.textPrimary,
    fontSize: 26,
    fontWeight: "600",
    letterSpacing: -0.5,
  },
  subtitle: {
    color: THEME.textSecondary,
    fontSize: 13,
  },
  card: {
    backgroundColor: THEME.surface,
    borderRadius: 14,
    padding: 20,
    gap: 14,
    borderWidth: 1,
    borderColor: THEME.border,
  },
  cardTitle: {
    color: THEME.textPrimary,
    fontSize: 16,
    fontWeight: "600",
    letterSpacing: -0.2,
  },
  cardBody: {
    color: THEME.textSecondary,
    fontSize: 13,
    lineHeight: 18,
  },
  field: {
    gap: 6,
  },
  label: {
    color: THEME.textSecondary,
    fontSize: 12,
    fontWeight: "500",
  },
  input: {
    backgroundColor: THEME.inputBg,
    color: THEME.textPrimary,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 13,
  },
  primaryButton: {
    backgroundColor: THEME.blue,
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: "center",
    marginTop: 4,
  },
  primaryButtonText: {
    color: THEME.white,
    fontSize: 13,
    fontWeight: "600",
  },
  secondaryButton: {
    backgroundColor: THEME.inputBg,
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: "center",
  },
  secondaryButtonText: {
    color: THEME.textPrimary,
    fontSize: 13,
    fontWeight: "500",
  },
  status: {
    color: THEME.textSecondary,
    fontSize: 12,
    textAlign: "center",
  },
  error: {
    color: THEME.red,
    fontSize: 12,
    textAlign: "center",
  },
  localLink: {
    alignSelf: "center",
    marginTop: 4,
  },
  localText: {
    color: THEME.textTertiary,
    fontSize: 12,
  },
});
