import { Text, View } from "react-native";

import { onboardingStyles } from "./OnboardingView.styles";

export type OnboardingStep =
  | "cf_connect"
  | "cf_verify"
  | "cf_select_account"
  | "cf_deploy"
  | "provider"
  | "access_login";

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
