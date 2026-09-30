import { NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

export interface GuardItem {
  id: string;
  firstName: string;
  lastName: string;
  name: string;
  employeeNumber: string;
  company: string;
  siteName: string;
  phone?: string;
  email?: string;
}

const DEFAULT_GUARDS: GuardItem[] = [
  {
    id: 'e495f1f3-72a0-4231-86fb-617c4624bbe5',
    firstName: 'Sipho',
    lastName: 'Khoza',
    name: 'Sipho Khoza',
    employeeNumber: 'G-101',
    company: 'Aiguille Security',
    siteName: 'Dawie Boerdery - Main Farm',
    phone: '+27 82 111 2222',
    email: 'guard@aiguillesecurity.co.za'
  },
  {
    id: '22222222-1111-4231-86fb-617c4624bbe5',
    firstName: 'Petrus',
    lastName: 'Ndlovu',
    name: 'Petrus Ndlovu',
    employeeNumber: 'G-102',
    company: 'Aiguille Security',
    siteName: 'Dawie Boerdery - Main Farm',
    phone: '+27 82 333 4444',
    email: 'guard@aiguillesecurity.co.za'
  }
];

export async function GET() {
  try {
    let supabase;
    try {
      supabase = createServiceRoleClient();
    } catch {
      return NextResponse.json({ guards: DEFAULT_GUARDS });
    }

    // 1. Fetch user IDs that have role 'guard'
    const { data: guardRoles } = await supabase
      .from('user_roles')
      .select('user_id')
      .eq('role', 'guard');

    if (!guardRoles || guardRoles.length === 0) {
      return NextResponse.json({ guards: DEFAULT_GUARDS });
    }

    const guardIds = guardRoles.map((r) => r.user_id);

    // 2. Fetch active profiles for these guards
    const { data: profiles, error } = await supabase
      .from('profiles')
      .select('id, first_name, last_name, employee_number, phone_number, is_active')
      .in('id', guardIds)
      .eq('is_active', true);

    if (error || !profiles || profiles.length === 0) {
      return NextResponse.json({ guards: DEFAULT_GUARDS });
    }

    const formattedGuards: GuardItem[] = profiles.map((p, idx) => ({
      id: p.id,
      firstName: p.first_name || 'Guard',
      lastName: p.last_name || '',
      name: `${p.first_name || 'Guard'} ${p.last_name || ''}`.trim(),
      employeeNumber: p.employee_number || `G-${101 + idx}`,
      company: 'Aiguille Security',
      siteName: 'Dawie Boerdery - Main Farm',
      phone: p.phone_number || ''
    }));

    return NextResponse.json({ guards: formattedGuards });
  } catch (err) {
    console.warn('[roster] Fallback to default guards:', err);
    return NextResponse.json({ guards: DEFAULT_GUARDS });
  }
}
