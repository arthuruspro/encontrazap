/**
 * Helper Asaas para EncontraZap
 * - Subscription PIX recorrente (R$97/mês)
 * - Cobrança PIX avulsa (buscas extras)
 */

const ASAAS_BASE = 'https://api.asaas.com/v3';

function getApiKey(): string {
  return Deno.env.get('ASAAS_API_KEY')!;
}

function headers(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'access_token': getApiKey(),
  };
}

/** Busca cliente pelo email */
export async function findCustomerByEmail(email: string): Promise<string | null> {
  const res = await fetch(`${ASAAS_BASE}/customers?email=${encodeURIComponent(email)}`, {
    method: 'GET',
    headers: headers(),
  });
  const data = await res.json();
  if (data.data && data.data.length > 0) {
    return data.data[0].id;
  }
  return null;
}

/** Cria novo cliente na Asaas */
export async function createCustomer(email: string, name: string, cpf?: string): Promise<string> {
  const body: Record<string, unknown> = {
    name: name || email,
    email,
    notificationDisabled: false,
  };
  if (cpf) {
    body.cpfCnpj = cpf.replace(/\D/g, '');
  }
  const res = await fetch(`${ASAAS_BASE}/customers`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    const msg = data.errors?.[0]?.description || JSON.stringify(data);
    throw new Error(`Asaas createCustomer: ${msg}`);
  }
  return data.id;
}

/** Cria autorização PIX Automático R$97/mês (recorrência automática) */
export async function createSubscription(customerId: string): Promise<{
  authorizationId: string;
  encodedImage: string;
  payload: string;
}> {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const startDate = tomorrow.toISOString().split('T')[0];

  // Gerar contractId único pra essa autorização (máx 35 chars)
  const shortId = Date.now().toString(36);
  const custShort = customerId.replace('cus_', '').slice(0, 12);
  const contractId = `ez-${custShort}-${shortId}`;

  const res = await fetch(`${ASAAS_BASE}/pix/automatic/authorizations`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      customerId,
      frequency: 'MONTHLY',
      contractId,
      startDate,
      immediateQrCode: {
        value: 97.00,
        originalValue: 97.00,
        expirationSeconds: 3600, // 1 hora pra pagar
      },
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    const msg = data.errors?.[0]?.description || JSON.stringify(data);
    throw new Error(`Asaas createPixAutomatic: ${msg}`);
  }

  return {
    authorizationId: data.id,
    encodedImage: data.encodedImage,
    payload: data.payload,
  };
}

/** Cria cobrança PIX avulsa (buscas extras) */
export async function createPixCharge(customerId: string, quantity: number): Promise<{
  paymentId: string;
  encodedImage: string;
  payload: string;
}> {
  const value = quantity * 1.90;
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const dueDate = tomorrow.toISOString().split('T')[0];

  const res = await fetch(`${ASAAS_BASE}/payments`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      customer: customerId,
      billingType: 'PIX',
      dueDate,
      value,
      description: `EncontraZap - ${quantity} buscas extras`,
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    const msg = data.errors?.[0]?.description || JSON.stringify(data);
    throw new Error(`Asaas createPixCharge: ${msg}`);
  }

  const qr = await getPixQrCode(data.id);

  return {
    paymentId: data.id,
    encodedImage: qr.encodedImage,
    payload: qr.payload,
  };
}

/** Busca QR Code PIX de uma cobrança */
export async function getPixQrCode(paymentId: string): Promise<{
  encodedImage: string;
  payload: string;
}> {
  const res = await fetch(`${ASAAS_BASE}/payments/${paymentId}/pixQrCode`, {
    method: 'GET',
    headers: headers(),
  });
  const data = await res.json();
  if (!res.ok) {
    const msg = data.errors?.[0]?.description || JSON.stringify(data);
    throw new Error(`Asaas getPixQrCode: ${msg}`);
  }
  return {
    encodedImage: data.encodedImage,
    payload: data.payload,
  };
}

/** Verifica status de pagamento (cobrança avulsa) */
export async function getPaymentStatus(paymentId: string): Promise<{
  status: string;
  paid: boolean;
}> {
  const res = await fetch(`${ASAAS_BASE}/payments/${paymentId}`, {
    method: 'GET',
    headers: headers(),
  });
  const data = await res.json();
  if (!res.ok) {
    const msg = data.errors?.[0]?.description || JSON.stringify(data);
    throw new Error(`Asaas getPaymentStatus: ${msg}`);
  }
  return {
    status: data.status,
    paid: data.status === 'RECEIVED' || data.status === 'CONFIRMED',
  };
}

/** Verifica status da autorização PIX Automático */
export async function getPixAutomaticStatus(authorizationId: string): Promise<{
  status: string;
  active: boolean;
}> {
  const res = await fetch(`${ASAAS_BASE}/pix/automatic/authorizations/${authorizationId}`, {
    method: 'GET',
    headers: headers(),
  });
  const data = await res.json();
  if (!res.ok) {
    const msg = data.errors?.[0]?.description || JSON.stringify(data);
    throw new Error(`Asaas getPixAutomaticStatus: ${msg}`);
  }
  return {
    status: data.status,
    active: data.status === 'ACTIVE',
  };
}
