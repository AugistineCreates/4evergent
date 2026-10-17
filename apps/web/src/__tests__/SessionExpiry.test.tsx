import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

// Stub the login page so these tests target the session-expiry path rather
// than the provider flows (covered by Login.test.tsx). The stub renders the
// `notice` prop RequireAuth passes and exposes a sign-in affordance.
vi.mock('../pages/Login', () => ({
  default: ({ onSuccess, notice }: { onSuccess: () => void; notice?: string }) => (
    <div>
      {notice && (
        <div role="alert" data-testid="session-expiry-notice">
          {notice}
        </div>
      )}
      <button type="button" onClick={onSuccess}>
        Sign In
      </button>
    </div>
  ),
}));

import { RequireAuth } from '../App';
import { api, ApiError, isUnauthorizedError } from '../api';
import { storeAuth, getStoredToken } from '../auth';

const ME = {
  subject: 'user-sub',
  ownerId: 'owner',
  method: 'email',
  displayName: 'Test User',
  email: 'user@example.com',
};

const mockFetch = vi.fn();

function response(status: number, body: unknown = null): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function renderProtected() {
  return render(
    <MemoryRouter initialEntries={['/agents']}>
      <RequireAuth>
        <div data-testid="dashboard">Dashboard Content</div>
      </RequireAuth>
    </MemoryRouter>
  );
}

async function mountAuthenticated() {
  // First request is the mount-time /auth/me probe — a valid session.
  mockFetch.mockResolvedValueOnce(response(200, ME));
  renderProtected();
  await waitFor(() => expect(screen.getByTestId('dashboard')).toBeInTheDocument());
}

describe('session expiry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('isUnauthorizedError only matches a 401', () => {
    expect(isUnauthorizedError(new ApiError(401, 'unauthorized'))).toBe(true);
    expect(isUnauthorizedError(new ApiError(500, 'boom'))).toBe(false);
    expect(isUnauthorizedError(new Error('network down'))).toBe(false);
  });

  test('a 401 shows the session-expiry notice and the login affordance', async () => {
    storeAuth('legacy-token', 'subject');
    await mountAuthenticated();

    // A session-authenticated request fails because the session ended.
    mockFetch.mockResolvedValueOnce(response(401, { error: 'unauthorized' }));
    await act(async () => {
      await expect(api.listAgents()).rejects.toBeInstanceOf(ApiError);
    });

    await waitFor(() => {
      expect(screen.getByTestId('session-expiry-notice')).toHaveTextContent(/session has expired/i);
    });
    expect(screen.getByRole('button', { name: 'Sign In' })).toBeInTheDocument();
    expect(screen.queryByTestId('dashboard')).not.toBeInTheDocument();
    // Credentials are cleared on expiry.
    expect(getStoredToken()).toBeNull();
  });

  test('a non-401 error does not trigger expiry or clear credentials', async () => {
    storeAuth('legacy-token', 'subject');
    await mountAuthenticated();

    mockFetch.mockResolvedValueOnce(response(500, { error: 'boom' }));
    await act(async () => {
      await expect(api.listAgents()).rejects.toBeInstanceOf(ApiError);
    });

    // Still on the dashboard, no expiry notice, credentials untouched.
    expect(screen.getByTestId('dashboard')).toBeInTheDocument();
    expect(screen.queryByTestId('session-expiry-notice')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign In' })).not.toBeInTheDocument();
    expect(getStoredToken()).toBe('legacy-token');
  });

  test('signing in again restores the page at the same location', async () => {
    await mountAuthenticated();

    mockFetch.mockResolvedValueOnce(response(401, { error: 'unauthorized' }));
    await act(async () => {
      await expect(api.listAgents()).rejects.toBeInstanceOf(ApiError);
    });
    await waitFor(() => {
      expect(screen.getByTestId('session-expiry-notice')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Sign In' }));

    await waitFor(() => {
      expect(screen.getByTestId('dashboard')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('session-expiry-notice')).not.toBeInTheDocument();
  });

  test('a 401 from the login endpoint is not treated as a session expiry', async () => {
    await mountAuthenticated();

    // Wrong password: the login endpoint opts out of the expiry path.
    mockFetch.mockResolvedValueOnce(response(401, { error: 'invalid_credentials' }));
    await act(async () => {
      await expect(
        api.loginEmail({ email: 'user@example.com', password: 'wrongpass' })
      ).rejects.toBeInstanceOf(ApiError);
    });

    expect(screen.getByTestId('dashboard')).toBeInTheDocument();
    expect(screen.queryByTestId('session-expiry-notice')).not.toBeInTheDocument();
  });
});
