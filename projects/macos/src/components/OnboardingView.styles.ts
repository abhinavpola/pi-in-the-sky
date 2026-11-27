import { StyleSheet } from "react-native";

import { THEME } from "../theme";

export const onboardingStyles = StyleSheet.create({
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
    letterSpacing: -0.4,
  },
  subtitle: {
    color: THEME.textSecondary,
    fontSize: 14,
  },
  stepper: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  stepPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  stepBadge: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: THEME.inputBg,
    alignItems: "center",
    justifyContent: "center",
  },
  stepBadgeActive: {
    backgroundColor: THEME.blue,
  },
  stepBadgeDone: {
    backgroundColor: THEME.green,
  },
  stepBadgeText: {
    color: THEME.textSecondary,
    fontSize: 11,
    fontWeight: "600",
  },
  stepBadgeTextActive: {
    color: THEME.white,
  },
  stepLabel: {
    color: THEME.textTertiary,
    fontSize: 13,
    fontWeight: "500",
  },
  stepLabelActive: {
    color: THEME.textPrimary,
    fontWeight: "600",
  },
  stepDivider: {
    width: 20,
    height: 1,
    backgroundColor: THEME.border,
  },
  card: {
    backgroundColor: THEME.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: THEME.border,
    padding: 20,
    gap: 14,
  },
  cardTitle: {
    color: THEME.textPrimary,
    fontSize: 16,
    fontWeight: "600",
  },
  cardBody: {
    color: THEME.textSecondary,
    fontSize: 13,
    lineHeight: 18,
  },
  codeBox: {
    backgroundColor: THEME.inputBg,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: "center",
  },
  codeText: {
    color: THEME.textPrimary,
    fontSize: 22,
    fontWeight: "600",
    letterSpacing: 3,
  },
  accountList: {
    maxHeight: 240,
  },
  accountListContent: {
    gap: 10,
  },
  accountOption: {
    backgroundColor: THEME.inputBg,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 2,
  },
  accountName: {
    color: THEME.textPrimary,
    fontSize: 14,
    fontWeight: "600",
  },
  accountUrl: {
    color: THEME.textSecondary,
    fontSize: 12,
  },
  field: {
    gap: 6,
  },
  label: {
    color: THEME.textPrimary,
    fontSize: 13,
    fontWeight: "500",
  },
  input: {
    backgroundColor: THEME.inputBg,
    color: THEME.textPrimary,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
  },
  primaryButton: {
    backgroundColor: THEME.blue,
    borderRadius: 9,
    paddingVertical: 11,
    alignItems: "center",
    marginTop: 2,
  },
  primaryButtonText: {
    color: THEME.white,
    fontSize: 14,
    fontWeight: "600",
  },
  secondaryButton: {
    backgroundColor: THEME.inputBg,
    borderRadius: 9,
    paddingVertical: 11,
    alignItems: "center",
  },
  secondaryButtonText: {
    color: THEME.textPrimary,
    fontSize: 14,
    fontWeight: "500",
  },
  status: {
    color: THEME.textSecondary,
    fontSize: 13,
    textAlign: "center",
  },
  error: {
    color: THEME.red,
    fontSize: 13,
    textAlign: "center",
  },
  localLink: {
    alignItems: "center",
    paddingVertical: 4,
  },
  localText: {
    color: THEME.textTertiary,
    fontSize: 12,
  },
});
