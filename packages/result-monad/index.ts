export type Ok<T> = {
  readonly ok: true;
  readonly value: T;
};

export type Err<E> = {
  readonly ok: false;
  readonly error: E;
};

export type Result<T, E = Error> = Ok<T> | Err<E>;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok;
}

export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok;
}

export function map<T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => U,
): Result<U, E> {
  return result.ok ? ok(fn(result.value)) : result;
}

export function mapErr<T, E, F>(
  result: Result<T, E>,
  fn: (error: E) => F,
): Result<T, F> {
  return result.ok ? result : err(fn(result.error));
}

export function flatMap<T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => Result<U, E>,
): Result<U, E> {
  return result.ok ? fn(result.value) : result;
}

export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  return result.ok ? result.value : fallback;
}

export function tryCatch<T, E = Error>(
  fn: () => T,
  onError?: (thrown: unknown) => E,
): Result<T, E> {
  try {
    return ok(fn());
  } catch (thrown) {
    if (onError) {
      return err(onError(thrown));
    }
    return err(
      (thrown instanceof Error ? thrown : new Error(String(thrown))) as E,
    );
  }
}

export async function tryCatchAsync<T, E = Error>(
  fn: () => Promise<T>,
  onError?: (thrown: unknown) => E,
): Promise<Result<T, E>> {
  try {
    return ok(await fn());
  } catch (thrown) {
    if (onError) {
      return err(onError(thrown));
    }
    return err(
      (thrown instanceof Error ? thrown : new Error(String(thrown))) as E,
    );
  }
}
