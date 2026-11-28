import type {
  CloudflareAccount,
  CloudflareDeviceAuth,
} from "@pi-in-the-sky/client/cloudflare-device-auth";
import type { DiscoveredWorker } from "@pi-in-the-sky/client/onboarding";
import { Text, View } from "react-native";

import { onboardingStyles } from "./OnboardingView.styles";

export type OnboardingState =
  | { readonly kind: "cf_connect" }
  | { readonly kind: "cf_verify"; readonly deviceAuth: CloudflareDeviceAuth }
  | {
      readonly kind: "cf_select_account";
      readonly cfAccessToken: string;
      readonly workers: readonly DiscoveredWorker[];
    }
  | {
      readonly kind: "cf_deploy";
      readonly cfAccessToken: string;
      readonly accounts: readonly CloudflareAccount[];
    }
  | {
      readonly kind: "provider";
      readonly cfAccessToken: string;
      readonly worker: DiscoveredWorker;
      readonly fallbackWorkers: readonly DiscoveredWorker[];
    }
  | {
      readonly kind: "access_login";
      readonly workerUrl: string;
      readonly teamDomain: string;
      readonly clientId: string;
    };

type OnboardingStep = OnboardingState["kind"];

function getOnboardingPhase(step: OnboardingStep): 1 | 2 {
  switch (step) {
    case "cf_connect":
    case "cf_verify":
    case "cf_select_account":
    case "cf_deploy":
      return 1;
    case "provider":
    case "access_login":
      return 2;
    default: {
      step satisfies never;
      return 1;
    }
  }
}

type OnboardingStepperProps = {
  readonly step: OnboardingStep;
};

export function OnboardingStepper({ step }: OnboardingStepperProps) {
  const phase = getOnboardingPhase(step);
  return (
    <View style={onboardingStyles.stepper}>
      <View style={onboardingStyles.stepPill}>
        <View
          style={[
            onboardingStyles.stepBadge,
            phase === 1
              ? onboardingStyles.stepBadgeActive
              : onboardingStyles.stepBadgeDone,
          ]}
        >
          <Text
            style={[
              onboardingStyles.stepBadgeText,
              onboardingStyles.stepBadgeTextActive,
            ]}
          >
            {phase === 1 ? "1" : "✓"}
          </Text>
        </View>
        <Text
          style={[
            onboardingStyles.stepLabel,
            phase === 1 ? onboardingStyles.stepLabelActive : null,
          ]}
        >
          Cloudflare
        </Text>
      </View>
      <View style={onboardingStyles.stepDivider} />
      <View style={onboardingStyles.stepPill}>
        <View
          style={[
            onboardingStyles.stepBadge,
            phase === 2 ? onboardingStyles.stepBadgeActive : null,
          ]}
        >
          <Text
            style={[
              onboardingStyles.stepBadgeText,
              phase === 2 ? onboardingStyles.stepBadgeTextActive : null,
            ]}
          >
            2
          </Text>
        </View>
        <Text
          style={[
            onboardingStyles.stepLabel,
            phase === 2 ? onboardingStyles.stepLabelActive : null,
          ]}
        >
          Inference Provider
        </Text>
      </View>
    </View>
  );
}
