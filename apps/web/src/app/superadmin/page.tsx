import { redirect } from 'next/navigation';

export default function SuperAdminIndexPage(): never {
  redirect('/superadmin/organizations');
}
