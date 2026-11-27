import type { ConnectionConfig } from "@pi-in-the-sky/client/agent-client";
import {
  type CloudflareDeviceAuth,
  pollCloudflareDeviceToken,
  startCloudflareDeviceAuth,
} from "@pi-in-the-sky/client/cloudflare-device-auth";
import {
  DEPLOY_TO_CLOUDFLARE_URL,
  discoverCloudflareWorker,
  type DiscoveredWorker,
  fetchWorkerStatus,
  provisionWorkerSecrets,
} from "@pi-in-the-sky/client/onboarding";
import { LOCAL_DEV_AUTH_TOKEN } from "@pi-in-the-sky/client/protocol";
import { useEffect, useRef, useState } from "react";
import {
  Linking,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";

import { signInWithCloudflareAccess } from "../native";
import { THEME } from "../theme";
import { type OnboardingStep, OnboardingStepper } from "./OnboardingStepper";
import { onboardingStyles } from "./OnboardingView.styles";

type OnboardingViewProps = {
  readonly onComplete: (config: ConnectionConfig) => void;
};

export function OnboardingView({ onComplete }: OnboardingViewProps) {
  const [step, setStep] = useState<OnboardingStep>("cf_connect");
  const [nearAiApiKey, setNearAiApiKey] = useState("");
  const [cfAccessToken, setCfAccessToken] = useState("");
  const [deviceAuth, setDeviceAuth] = useState<CloudflareDeviceAuth | null>(
    null,
  );
  const [matchedWorkers, setMatchedWorkers] = useState<
    readonly DiscoveredWorker[]
  >([]);
  const [selectedWorker, setSelectedWorker] = useState<DiscoveredWorker | null>(
    null,
  );
  const [workerUrl, setWorkerUrl] = useState("");
  const [teamDomain, setTeamDomain] = useState("");
  const [clientId, setClientId] = useState("");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const pollAbortRef = useRef<AbortController | null>(null);
  const flowEpochRef = useRef(0);
  const configuringRef = useRef(false);

  useEffect(() => {
    return () => {
      flowEpochRef.current += 1;
      configuringRef.current = false;
      pollAbortRef.current?.abort();
    };
  }, []);

  const verifyLiveWorker = async (candidateUrl: string, epoch: number) => {
    setStatusMessage("Connecting...");
    const status = await fetchWorkerStatus(candidateUrl);
    if (flowEpochRef.current !== epoch) {
      return;
    }
    switch (status.kind) {
      case "offline":
        setStatusMessage(null);
        setErrorText(status.reason);
        setStep("cf_deploy");
        return;
      case "live_no_oauth":
        setCfAccessToken("");
        setNearAiApiKey("");
        setMatchedWorkers([]);
        setSelectedWorker(null);
        setStatusMessage(null);
        onComplete({
          baseUrl: status.baseUrl,
          authToken: LOCAL_DEV_AUTH_TOKEN,
        });
        return;
      case "live_oauth_ready":
        setCfAccessToken("");
        setNearAiApiKey("");
        setMatchedWorkers([]);
        setSelectedWorker(null);
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

  const discoverWorker = async (token: string, epoch: number) => {
    if (flowEpochRef.current !== epoch) {
      return;
    }
    setErrorText(null);
    setStatusMessage("Checking Cloudflare...");
    const discovery = await discoverCloudflareWorker(token);
    if (flowEpochRef.current !== epoch) {
      return;
    }
    switch (discovery.kind) {
      case "found": {
        const single = discovery.matches[0];
        if (
          discovery.accountCount === 1 &&
          discovery.matches.length === 1 &&
          single
        ) {
          setSelectedWorker(single);
          setMatchedWorkers([]);
          setStatusMessage(null);
          setStep("provider");
          return;
        }
        setMatchedWorkers(discovery.matches);
        setSelectedWorker(null);
        setStatusMessage(null);
        setStep("cf_select_account");
        return;
      }
      case "not_deployed":
        setStatusMessage(null);
        setStep("cf_deploy");
        return;
      case "error":
        setStatusMessage(null);
        setErrorText(discovery.message);
        setStep("cf_connect");
        return;
      default: {
        discovery satisfies never;
      }
    }
  };

  const handleSignInWithCloudflare = async () => {
    if (statusMessage !== null) {
      return;
    }
    flowEpochRef.current += 1;
    const epoch = flowEpochRef.current;
    setErrorText(null);
    setStatusMessage("Starting Cloudflare sign-in...");
    const started = await startCloudflareDeviceAuth();
    if (flowEpochRef.current !== epoch) {
      return;
    }
    if (!started.ok) {
      setStatusMessage(null);
      setErrorText(started.error);
      return;
    }
    pollAbortRef.current?.abort();
    const controller = new AbortController();
    pollAbortRef.current = controller;
    setDeviceAuth(started.value);
    setStatusMessage("Waiting for approval...");
    setStep("cf_verify");
    await Linking.openURL(started.value.verificationUriComplete);

    const polled = await pollCloudflareDeviceToken(
      started.value,
      controller.signal,
    );
    if (controller.signal.aborted || flowEpochRef.current !== epoch) {
      return;
    }
    if (!polled.ok) {
      setStatusMessage(null);
      setErrorText(polled.error);
      setStep("cf_connect");
      return;
    }
    setCfAccessToken(polled.accessToken);
    await discoverWorker(polled.accessToken, epoch);
  };

  const handleConfigureProvider = async () => {
    if (!nearAiApiKey.trim()) {
      setErrorText("Enter your NEAR AI key to continue.");
      return;
    }
    if (!selectedWorker || !cfAccessToken) {
      setErrorText("Sign in with Cloudflare first.");
      setStep("cf_connect");
      return;
    }
    if (configuringRef.current) {
      return;
    }
    const epoch = flowEpochRef.current;
    configuringRef.current = true;
    try {
      setErrorText(null);
      setStatusMessage("Configuring...");
      const provisioned = await provisionWorkerSecrets(
        cfAccessToken,
        selectedWorker.accountId,
        nearAiApiKey,
      );
      if (flowEpochRef.current !== epoch) {
        return;
      }
      if (!provisioned.ok) {
        setStatusMessage(null);
        setErrorText(provisioned.error);
        return;
      }
      setWorkerUrl(selectedWorker.baseUrl);
      await verifyLiveWorker(selectedWorker.baseUrl, epoch);
    } finally {
      configuringRef.current = false;
    }
  };

  const handleCancelFlow = () => {
    flowEpochRef.current += 1;
    configuringRef.current = false;
    pollAbortRef.current?.abort();
    pollAbortRef.current = null;
    setCfAccessToken("");
    setDeviceAuth(null);
    setMatchedWorkers([]);
    setSelectedWorker(null);
    setStatusMessage(null);
    setErrorText(null);
    setStep("cf_connect");
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
      case "cf_connect":
        return (
          <View style={onboardingStyles.card}>
            <Text style={onboardingStyles.cardTitle}>Cloudflare</Text>
            <Text style={onboardingStyles.cardBody}>
              Sign in to connect or deploy your personal Worker.
            </Text>
            <Pressable
              style={onboardingStyles.primaryButton}
              disabled={statusMessage !== null}
              onPress={() => {
                void handleSignInWithCloudflare();
              }}
            >
              <Text style={onboardingStyles.primaryButtonText}>
                Sign in with Cloudflare
              </Text>
            </Pressable>
          </View>
        );
      case "cf_verify":
        return (
          <View style={onboardingStyles.card}>
            <Text style={onboardingStyles.cardTitle}>Approve in Browser</Text>
            <Text style={onboardingStyles.cardBody}>
              Confirm this code in Cloudflare to continue.
            </Text>
            {deviceAuth ? (
              <View style={onboardingStyles.codeBox}>
                <Text style={onboardingStyles.codeText}>
                  {deviceAuth.userCode}
                </Text>
              </View>
            ) : null}
            {deviceAuth ? (
              <Pressable
                style={onboardingStyles.secondaryButton}
                onPress={() => {
                  void Linking.openURL(deviceAuth.verificationUriComplete);
                }}
              >
                <Text style={onboardingStyles.secondaryButtonText}>
                  Open Cloudflare
                </Text>
              </Pressable>
            ) : null}
            <Pressable
              style={onboardingStyles.localLink}
              onPress={handleCancelFlow}
            >
              <Text style={onboardingStyles.localText}>Cancel</Text>
            </Pressable>
          </View>
        );
      case "cf_select_account":
        return (
          <View style={onboardingStyles.card}>
            <Text style={onboardingStyles.cardTitle}>Choose Account</Text>
            <Text style={onboardingStyles.cardBody}>
              Select which Cloudflare account to use.
            </Text>
            <ScrollView
              style={onboardingStyles.accountList}
              contentContainerStyle={onboardingStyles.accountListContent}
            >
              {matchedWorkers.map((match) => (
                <Pressable
                  key={match.accountId}
                  style={onboardingStyles.accountOption}
                  onPress={() => {
                    setErrorText(null);
                    setSelectedWorker(match);
                    setStep("provider");
                  }}
                >
                  <Text style={onboardingStyles.accountName}>
                    {match.accountName}
                  </Text>
                  <Text style={onboardingStyles.accountUrl}>
                    {match.baseUrl}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
            <Pressable
              style={onboardingStyles.localLink}
              onPress={handleCancelFlow}
            >
              <Text style={onboardingStyles.localText}>Cancel</Text>
            </Pressable>
          </View>
        );
      case "cf_deploy":
        return (
          <View style={onboardingStyles.card}>
            <Text style={onboardingStyles.cardTitle}>Deploy to Cloudflare</Text>
            <Text style={onboardingStyles.cardBody}>
              Finish deploying in your browser, then continue.
            </Text>
            <Pressable
              style={onboardingStyles.primaryButton}
              onPress={() => {
                void handleOpenDeploy();
              }}
            >
              <Text style={onboardingStyles.primaryButtonText}>
                Deploy to Cloudflare
              </Text>
            </Pressable>
            <Pressable
              style={onboardingStyles.secondaryButton}
              disabled={statusMessage !== null}
              onPress={() => {
                flowEpochRef.current += 1;
                const epoch = flowEpochRef.current;
                void discoverWorker(cfAccessToken, epoch);
              }}
            >
              <Text style={onboardingStyles.secondaryButtonText}>Continue</Text>
            </Pressable>
            <Pressable
              style={onboardingStyles.localLink}
              onPress={handleCancelFlow}
            >
              <Text style={onboardingStyles.localText}>Back</Text>
            </Pressable>
          </View>
        );
      case "provider":
        return (
          <View style={onboardingStyles.card}>
            <Text style={onboardingStyles.cardTitle}>Inference Provider</Text>
            <Text style={onboardingStyles.cardBody}>
              Add your NEAR AI key for{" "}
              {selectedWorker?.accountName ?? "Cloudflare"}.
            </Text>
            <View style={onboardingStyles.field}>
              <Text style={onboardingStyles.label}>NEAR AI Key</Text>
              <TextInput
                style={onboardingStyles.input}
                value={nearAiApiKey}
                onChangeText={setNearAiApiKey}
                secureTextEntry
                placeholder="sk-..."
                placeholderTextColor={THEME.textTertiary}
              />
            </View>
            <Pressable
              style={onboardingStyles.primaryButton}
              disabled={statusMessage !== null}
              onPress={() => {
                void handleConfigureProvider();
              }}
            >
              <Text style={onboardingStyles.primaryButtonText}>Continue</Text>
            </Pressable>
            <Pressable
              style={onboardingStyles.localLink}
              disabled={statusMessage !== null}
              onPress={() => {
                setErrorText(null);
                if (matchedWorkers.length > 0) {
                  setSelectedWorker(null);
                  setStep("cf_select_account");
                  return;
                }
                handleCancelFlow();
              }}
            >
              <Text style={onboardingStyles.localText}>Back</Text>
            </Pressable>
          </View>
        );
      case "access_login":
        return (
          <View style={onboardingStyles.card}>
            <Text style={onboardingStyles.cardTitle}>Sign In</Text>
            <Text style={onboardingStyles.cardBody}>{teamDomain}</Text>
            <Pressable
              style={onboardingStyles.primaryButton}
              onPress={() => {
                void handleAccessLogin();
              }}
            >
              <Text style={onboardingStyles.primaryButtonText}>
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
    <View style={onboardingStyles.container}>
      <View style={onboardingStyles.frame}>
        <View style={onboardingStyles.header}>
          <Text style={onboardingStyles.title}>Pi in the Sky</Text>
          <Text style={onboardingStyles.subtitle}>
            Set up your personal assistant
          </Text>
        </View>

        <OnboardingStepper step={step} />

        {renderStep(step)}

        {statusMessage ? (
          <Text style={onboardingStyles.status}>{statusMessage}</Text>
        ) : null}
        {errorText ? (
          <Text style={onboardingStyles.error}>{errorText}</Text>
        ) : null}
      </View>
    </View>
  );
}
