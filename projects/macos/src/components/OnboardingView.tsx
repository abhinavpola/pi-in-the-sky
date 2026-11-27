import {
  type ConnectionConfig,
  validateBaseUrl,
} from "@pi-in-the-sky/client/agent-client";
import {
  buildAccessAuthorizeUrl,
  createPkceSession,
  DEPLOY_TO_CLOUDFLARE_URL,
  discoverCloudflareWorker,
  fetchWorkerStatus,
  handleOAuthCallbackUrl,
  type PkceSession,
  provisionWorkerSecrets,
} from "@pi-in-the-sky/client/onboarding";
import { LOCAL_DEV_AUTH_TOKEN } from "@pi-in-the-sky/client/protocol";
import { useEffect, useState } from "react";
import {
  Linking,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

type OnboardingStep = "discover" | "deploy" | "access_login";

type OnboardingViewProps = {
  readonly initialBaseUrl: string;
  readonly onComplete: (config: ConnectionConfig) => void;
  readonly onSkip: () => void;
};

export function OnboardingView({
  initialBaseUrl,
  onComplete,
  onSkip,
}: OnboardingViewProps) {
  const [step, setStep] = useState<OnboardingStep>("discover");
  const [cfAccountId, setCfAccountId] = useState("");
  const [cfApiToken, setCfApiToken] = useState("");
  const [nearAiApiKey, setNearAiApiKey] = useState("");
  const [workerUrl, setWorkerUrl] = useState(initialBaseUrl);
  const [teamDomain, setTeamDomain] = useState("");
  const [clientId, setClientId] = useState("");
  const [pkceSession, setPkceSession] = useState<PkceSession | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);

  useEffect(() => {
    if (step !== "access_login" || !teamDomain || !clientId || !pkceSession) {
      return;
    }
    const subscription = Linking.addEventListener("url", ({ url }) => {
      setStatusMessage("Exchanging Cloudflare Access authorization code...");
      void handleOAuthCallbackUrl(url, teamDomain, clientId, pkceSession).then(
        (result) => {
          switch (result.kind) {
            case "ignore":
              return;
            case "error":
              setPkceSession(null);
              setStatusMessage(null);
              setErrorText(result.message);
              return;
            case "exchanged":
              setPkceSession(null);
              onComplete({
                baseUrl: workerUrl,
                agentId: "me",
                authToken: result.accessToken,
                refreshToken: result.refreshToken,
                accessTeamDomain: teamDomain,
                accessClientId: clientId,
              });
              return;
            default: {
              result satisfies never;
            }
          }
        },
      );
    });
    return () => {
      subscription.remove();
    };
  }, [step, teamDomain, clientId, pkceSession, workerUrl, onComplete]);

  const checkLiveness = async (candidateUrl: string) => {
    const validated = validateBaseUrl(candidateUrl);
    if (!validated.ok) {
      setErrorText(validated.error);
      return;
    }
    setErrorText(null);
    setStatusMessage("Checking Worker liveness...");
    const status = await fetchWorkerStatus(validated.value);
    switch (status.kind) {
      case "offline":
        setStatusMessage(null);
        setErrorText(`Worker not reachable yet: ${status.reason}`);
        setStep("deploy");
        return;
      case "live_no_oauth":
        setStatusMessage("Worker is live (local dev mode).");
        onComplete({
          baseUrl: status.baseUrl,
          agentId: "personal",
          authToken: LOCAL_DEV_AUTH_TOKEN,
        });
        return;
      case "live_oauth_ready":
        setWorkerUrl(status.baseUrl);
        setTeamDomain(status.teamDomain);
        setClientId(status.clientId);
        setStatusMessage("Worker is live and Cloudflare Access is ready.");
        setStep("access_login");
        return;
      default: {
        status satisfies never;
      }
    }
  };

  const handleDiscover = async () => {
    if (!cfAccountId.trim() || !cfApiToken.trim()) {
      await checkLiveness(workerUrl);
      return;
    }
    setErrorText(null);
    setStatusMessage("Checking your Cloudflare account for pi-in-the-sky...");
    const result = await discoverCloudflareWorker(cfApiToken, cfAccountId);
    switch (result.kind) {
      case "found":
        setWorkerUrl(result.baseUrl);
        if (nearAiApiKey.trim()) {
          setStatusMessage(
            "Generating vault key and configuring Worker secrets...",
          );
          const provisioned = await provisionWorkerSecrets(
            cfApiToken,
            cfAccountId,
            nearAiApiKey,
          );
          if (!provisioned.ok) {
            setStatusMessage(null);
            setErrorText(provisioned.error);
            return;
          }
          setNearAiApiKey("");
        }
        setCfApiToken("");
        await checkLiveness(result.baseUrl);
        return;
      case "not_deployed":
        setStatusMessage(
          "No pi-in-the-sky Worker found on your account yet. Deploy it in 1 click below.",
        );
        setStep("deploy");
        return;
      case "error":
        setStatusMessage(null);
        setErrorText(result.message);
        return;
      default: {
        result satisfies never;
      }
    }
  };

  const handleOpenDeploy = async () => {
    setErrorText(null);
    await Linking.openURL(DEPLOY_TO_CLOUDFLARE_URL);
    setStatusMessage(
      "Opened Deploy to Cloudflare in your browser. Once finished, tap Check Liveness.",
    );
  };

  const handleAccessLogin = async () => {
    setErrorText(null);
    const nextPkce = createPkceSession();
    setPkceSession(nextPkce);
    const authorizeUrl = buildAccessAuthorizeUrl(
      teamDomain,
      clientId,
      nextPkce,
    );
    await Linking.openURL(authorizeUrl);
    setStatusMessage(
      "Waiting for Cloudflare Access sign-in callback (piinthesky://auth/callback)...",
    );
  };

  const renderStep = (current: OnboardingStep) => {
    switch (current) {
      case "discover":
        return (
          <View style={styles.card}>
            <Text style={styles.stepTitle}>
              1. Connect Cloudflare or Enter Worker URL
            </Text>
            <Text style={styles.desc}>
              Check whether your private pi-in-the-sky Worker is already
              deployed on Cloudflare.
            </Text>
            <Text style={styles.label}>Cloudflare Account ID (optional)</Text>
            <TextInput
              style={styles.input}
              value={cfAccountId}
              onChangeText={setCfAccountId}
              placeholder="Cloudflare Account ID"
              placeholderTextColor="#64748b"
            />
            <Text style={styles.label}>
              Cloudflare Setup Token (discarded after check)
            </Text>
            <TextInput
              style={styles.input}
              value={cfApiToken}
              onChangeText={setCfApiToken}
              secureTextEntry
              placeholder="Cloudflare OAuth / API token"
              placeholderTextColor="#64748b"
            />
            <Text style={styles.label}>
              NEAR AI API Key (optional, auto-uploaded to Worker secrets)
            </Text>
            <TextInput
              style={styles.input}
              value={nearAiApiKey}
              onChangeText={setNearAiApiKey}
              secureTextEntry
              placeholder="sk-..."
              placeholderTextColor="#64748b"
            />
            <Text style={styles.label}>Or Existing Worker URL</Text>
            <TextInput
              style={styles.input}
              value={workerUrl}
              onChangeText={setWorkerUrl}
              placeholder="https://pi-in-the-sky.your-subdomain.workers.dev"
              placeholderTextColor="#64748b"
            />
            <View style={styles.row}>
              <Pressable
                style={styles.primaryButton}
                onPress={() => {
                  void handleDiscover();
                }}
              >
                <Text style={styles.buttonText}>Check Deployment</Text>
              </Pressable>
              <Pressable
                style={styles.deployButton}
                onPress={() => {
                  setStep("deploy");
                }}
              >
                <Text style={styles.buttonText}>Deploy to Cloudflare</Text>
              </Pressable>
            </View>
          </View>
        );
      case "deploy":
        return (
          <View style={styles.card}>
            <Text style={styles.stepTitle}>
              2. 1-Click Deploy to Cloudflare
            </Text>
            <Text style={styles.desc}>
              Your personal agent Worker is not live yet. Deploy it to your own
              Cloudflare account with 1 click, then verify liveness.
            </Text>
            <Pressable
              style={styles.deployButton}
              onPress={() => {
                void handleOpenDeploy();
              }}
            >
              <Text style={styles.buttonText}>Deploy to Cloudflare</Text>
            </Pressable>
            <Text style={styles.label}>Deployed Worker URL</Text>
            <TextInput
              style={styles.input}
              value={workerUrl}
              onChangeText={setWorkerUrl}
              placeholder="https://pi-in-the-sky.your-subdomain.workers.dev"
              placeholderTextColor="#64748b"
            />
            <View style={styles.row}>
              <Pressable
                style={styles.primaryButton}
                onPress={() => {
                  void checkLiveness(workerUrl);
                }}
              >
                <Text style={styles.buttonText}>Check Liveness</Text>
              </Pressable>
              <Pressable
                style={styles.secondaryButton}
                onPress={() => setStep("discover")}
              >
                <Text style={styles.buttonText}>Back</Text>
              </Pressable>
            </View>
          </View>
        );
      case "access_login":
        return (
          <View style={styles.card}>
            <Text style={styles.stepTitle}>
              3. Sign in with Cloudflare Access
            </Text>
            <Text style={styles.desc}>
              Sign in once via your browser (Passkey, Google, or GitHub).
              Includes a refreshable session token so you do not have to sign in
              daily.
            </Text>
            <Text style={styles.meta}>Worker: {workerUrl}</Text>
            <Text style={styles.meta}>Access Team: {teamDomain}</Text>
            <Pressable
              style={styles.oauthButton}
              onPress={() => {
                void handleAccessLogin();
              }}
            >
              <Text style={styles.buttonText}>
                Sign in with Cloudflare Access
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
      <Text style={styles.heading}>Set up Pi in the Sky</Text>
      {renderStep(step)}
      {statusMessage ? (
        <Text style={styles.status}>{statusMessage}</Text>
      ) : null}
      {errorText ? <Text style={styles.error}>{errorText}</Text> : null}
      <Pressable style={styles.skipButton} onPress={onSkip}>
        <Text style={styles.skipText}>Skip setup (local dev)</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0b1120", padding: 20, gap: 12 },
  heading: { color: "#f8fafc", fontSize: 18, fontWeight: "700" },
  card: {
    backgroundColor: "#111827",
    borderColor: "#1e293b",
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    gap: 10,
  },
  stepTitle: { color: "#f8fafc", fontSize: 15, fontWeight: "700" },
  desc: { color: "#94a3b8", fontSize: 13 },
  meta: { color: "#cbd5e1", fontSize: 12 },
  label: { color: "#cbd5e1", fontSize: 12, fontWeight: "600", marginTop: 4 },
  input: {
    backgroundColor: "#1e293b",
    color: "#f8fafc",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 13,
  },
  row: { flexDirection: "row", gap: 10, marginTop: 6 },
  primaryButton: {
    backgroundColor: "#2563eb",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
    alignSelf: "flex-start",
  },
  deployButton: {
    backgroundColor: "#ea580c",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
    alignSelf: "flex-start",
  },
  oauthButton: {
    backgroundColor: "#0f766e",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
    alignSelf: "flex-start",
    marginTop: 4,
  },
  secondaryButton: {
    backgroundColor: "#334155",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
    alignSelf: "flex-start",
  },
  buttonText: { color: "#ffffff", fontSize: 13, fontWeight: "600" },
  status: { color: "#93c5fd", fontSize: 12 },
  error: { color: "#fca5a5", fontSize: 12 },
  skipButton: { alignSelf: "flex-start", paddingVertical: 6 },
  skipText: { color: "#94a3b8", fontSize: 12 },
});
