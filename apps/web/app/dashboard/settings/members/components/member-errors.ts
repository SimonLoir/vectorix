type MemberActionError =
    | 'permission'
    | 'session'
    | 'lastOwner'
    | 'alreadyMember'
    | 'alreadyInvited'
    | 'notFound'
    | 'limit'
    | 'role'
    | 'generic';

/** Native messages are untrusted; only known codes select localized UI copy. */
export function memberActionError(error: unknown): MemberActionError {
    if (!error || typeof error !== 'object') return 'generic';
    const code = 'code' in error ? error.code : undefined;
    switch (code) {
        case 'UNAUTHORIZED':
        case 'SESSION_EXPIRED':
            return 'session';
        case 'FORBIDDEN':
        case 'USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION':
        case 'YOU_ARE_NOT_A_MEMBER_OF_THIS_ORGANIZATION':
        case 'YOU_ARE_NOT_ALLOWED_TO_DELETE_THIS_MEMBER':
        case 'YOU_ARE_NOT_ALLOWED_TO_UPDATE_THIS_MEMBER':
        case 'YOU_ARE_NOT_ALLOWED_TO_INVITE_USERS_TO_THIS_ORGANIZATION':
        case 'YOU_ARE_NOT_ALLOWED_TO_CANCEL_THIS_INVITATION':
            return 'permission';
        case 'YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER':
        case 'YOU_CANNOT_LEAVE_THE_ORGANIZATION_WITHOUT_AN_OWNER':
            return 'lastOwner';
        case 'USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION':
            return 'alreadyMember';
        case 'USER_IS_ALREADY_INVITED_TO_THIS_ORGANIZATION':
            return 'alreadyInvited';
        case 'MEMBER_NOT_FOUND':
        case 'INVITATION_NOT_FOUND':
        case 'ORGANIZATION_NOT_FOUND':
        case 'NO_ACTIVE_ORGANIZATION':
            return 'notFound';
        case 'INVITATION_LIMIT_REACHED':
        case 'ORGANIZATION_MEMBERSHIP_LIMIT_REACHED':
            return 'limit';
        case 'ROLE_NOT_FOUND':
        case 'YOU_ARE_NOT_ALLOWED_TO_INVITE_USER_WITH_THIS_ROLE':
            return 'role';
        default:
            return 'generic';
    }
}
