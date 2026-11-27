import AppKit
import AuthenticationServices
import Foundation
import React
import Security

@objc(PiInTheSkyNative)
final class PiInTheSkyNative: NSObject, ASWebAuthenticationPresentationContextProviding {
  private let keychainService = "com.piinthesky.macos"
  private let keychainAccount = "connection_config"
  private var activeSession: ASWebAuthenticationSession?
  private var activeSessionId: UUID?

  @objc
  static func requiresMainQueueSetup() -> Bool {
    false
  }

  func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
    NSApplication.shared.keyWindow
      ?? NSApplication.shared.mainWindow
      ?? NSApplication.shared.windows.first
      ?? ASPresentationAnchor()
  }

  @objc(authenticate:callbackScheme:resolve:reject:)
  func authenticate(
    authorizeUrl: String,
    callbackScheme: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    guard let url = URL(string: authorizeUrl), !callbackScheme.isEmpty else {
      reject("AUTH_INVALID_ARGS", "Invalid authorize URL or callback scheme.", nil)
      return
    }

    DispatchQueue.main.async { [weak self] in
      guard let self else {
        reject("AUTH_DEALLOCATED", "Authentication module is no longer available.", nil)
        return
      }

      self.activeSession?.cancel()
      let sessionId = UUID()
      self.activeSessionId = sessionId

      let session = ASWebAuthenticationSession(
        url: url,
        callbackURLScheme: callbackScheme
      ) { [weak self] callbackURL, error in
        if self?.activeSessionId == sessionId {
          self?.activeSession = nil
          self?.activeSessionId = nil
        }

        if let error = error as NSError? {
          if error.domain == ASWebAuthenticationSessionErrorDomain,
             error.code == ASWebAuthenticationSessionError.canceledLogin.rawValue {
            reject("AUTH_CANCELLED", "Sign-in was cancelled.", error)
          } else {
            reject("AUTH_ERROR", error.localizedDescription, error)
          }
          return
        }

        guard let callbackURL else {
          reject("AUTH_ERROR", "Authentication session completed without a callback URL.", nil)
          return
        }

        resolve(callbackURL.absoluteString)
      }

      session.presentationContextProvider = self
      session.prefersEphemeralWebBrowserSession = false
      self.activeSession = session

      if !session.start() {
        if self.activeSessionId == sessionId {
          self.activeSession = nil
          self.activeSessionId = nil
        }
        reject("AUTH_START_FAILED", "Failed to start ASWebAuthenticationSession.", nil)
      }
    }
  }

  @objc(loadConnectionConfig:reject:)
  func loadConnectionConfig(
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    let query: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: keychainService,
      kSecAttrAccount: keychainAccount,
      kSecReturnData: true,
      kSecMatchLimit: kSecMatchLimitOne,
    ]

    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)

    if status == errSecItemNotFound {
      resolve(NSNull())
      return
    }

    guard status == errSecSuccess else {
      reject(
        "KEYCHAIN_READ_ERROR",
        SecCopyErrorMessageString(status, nil) as String? ?? "Keychain read failed (\(status)).",
        nil
      )
      return
    }

    guard let data = item as? Data, let text = String(data: data, encoding: .utf8) else {
      reject("KEYCHAIN_DECODE_ERROR", "Stored Keychain item could not be decoded as UTF-8.", nil)
      return
    }

    resolve(text)
  }

  @objc(saveConnectionConfig:resolve:reject:)
  func saveConnectionConfig(
    payload: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    guard let data = payload.data(using: .utf8) else {
      reject("KEYCHAIN_ENCODE_ERROR", "Connection config could not be encoded as UTF-8.", nil)
      return
    }

    let matchQuery: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: keychainService,
      kSecAttrAccount: keychainAccount,
    ]

    let deleteStatus = SecItemDelete(matchQuery as CFDictionary)
    if deleteStatus != errSecSuccess && deleteStatus != errSecItemNotFound {
      reject(
        "KEYCHAIN_DELETE_ERROR",
        SecCopyErrorMessageString(deleteStatus, nil) as String? ?? "Keychain replace failed (\(deleteStatus)).",
        nil
      )
      return
    }

    let addQuery: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: keychainService,
      kSecAttrAccount: keychainAccount,
      kSecValueData: data,
      kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
    ]

    let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
    guard addStatus == errSecSuccess else {
      reject(
        "KEYCHAIN_WRITE_ERROR",
        SecCopyErrorMessageString(addStatus, nil) as String? ?? "Keychain write failed (\(addStatus)).",
        nil
      )
      return
    }

    resolve(true)
  }

  @objc(clearConnectionConfig:reject:)
  func clearConnectionConfig(
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    let query: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: keychainService,
      kSecAttrAccount: keychainAccount,
    ]

    let status = SecItemDelete(query as CFDictionary)
    if status == errSecSuccess || status == errSecItemNotFound {
      resolve(true)
      return
    }

    reject(
      "KEYCHAIN_DELETE_ERROR",
      SecCopyErrorMessageString(status, nil) as String? ?? "Keychain delete failed (\(status)).",
      nil
    )
  }
}
