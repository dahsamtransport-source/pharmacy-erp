import { createClient } from '@supabase/supabase-js';

export type MerchantAuthContext = {
  userId: string;
  merchantId: string;
  role: 'owner' | 'manager' | 'staff' | 'inventory';
};

export class AuthenticationError extends Error {
  constructor(
    public readonly code:
      | 'AUTH_CONFIGURATION_MISSING'
      | 'AUTH_TOKEN_MISSING'
      | 'AUTH_TOKEN_INVALID'
      | 'MERCHANT_ACCESS_DENIED',
  ) {
    super(code);
    this.name = 'AuthenticationError';
  }
}

function readBearerToken(request: Request) {
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) {
    throw new AuthenticationError('AUTH_TOKEN_MISSING');
  }

  const token = authorization.slice('Bearer '.length).trim();
  if (!token) {
    throw new AuthenticationError('AUTH_TOKEN_MISSING');
  }

  return token;
}

export async function requireMerchantMember(
  request: Request,
  merchantId: string,
): Promise<MerchantAuthContext> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new AuthenticationError('AUTH_CONFIGURATION_MISSING');
  }

  const token = readBearerToken(request);
  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  if (userError || !userData.user) {
    throw new AuthenticationError('AUTH_TOKEN_INVALID');
  }

  const { data: membership, error: membershipError } = await supabase
    .from('merchant_members')
    .select('role')
    .eq('merchant_id', merchantId)
    .eq('user_id', userData.user.id)
    .maybeSingle();

  if (membershipError || !membership) {
    throw new AuthenticationError('MERCHANT_ACCESS_DENIED');
  }

  const role = membership.role;
  if (!['owner', 'manager', 'staff', 'inventory'].includes(role)) {
    throw new AuthenticationError('MERCHANT_ACCESS_DENIED');
  }

  return {
    userId: userData.user.id,
    merchantId,
    role: role as MerchantAuthContext['role'],
  };
}
