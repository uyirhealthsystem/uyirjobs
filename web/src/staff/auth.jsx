import { createContext, useContext } from 'react';

/** { user, meta } for the signed-in staff member. meta: statuses, roles, docTypes, districts… */
export const AuthContext = createContext(null);
export const useAuth = () => useContext(AuthContext);
export const isSuper = user => user?.role === 'super_admin';

export const NOT_SENT = 'Invite NOT sent: this nurse has no SMS consent (or is on Do Not Contact). Share the registration link yourself.';
export const sentBy = ch => (ch[0] === 'whatsapp' ? 'registration link sent on WhatsApp' : 'SMS sent with the WhatsApp link');
