// Minimal Murmur ICE interface for quad bot.
// Covers only the operations needed for user registration, ACLs, and cert pinning.
// Based on the Murmur 1.5.x MumbleServer.ice interface.
// Full interface: https://github.com/mumble-voip/mumble/blob/master/src/murmur/MumbleServer.ice

module Murmur {
    /**
     * User information keys used in UserInfoMap.
     */
    enum UserInfo {
        UserName,         // 0 — Mumble username
        UserEmail,        // 1 — User email
        UserComment,      // 2 — User comment/description
        UserHash,         // 3 — Certificate hash (SHA-1 hex)
        UserPassword,     // 4 — Password (write-only, never returned in reads)
        UserLastActive,   // 5 — Last active timestamp
        UserKDFIterations // 6 — KDF iterations for password storage
    };

    /**
     * Channel ACL entry.
     */
    struct ACL {
        bool applyHere;   // Does this ACL apply to the current channel?
        bool applySubs;   // Does this ACL apply to subchannels?
        bool inherited;   // Is this ACL inherited from a parent?
        int userid;       // Murmur user ID (-1 if group-based)
        string group;     // Group name (if userid == -1)
        int allow;        // Bitfield of allowed permissions
        int deny;         // Bitfield of denied permissions
    };

    /**
     * Channel group.
     */
    struct Group {
        string name;
        bool inherited;
        bool inherit;
        bool inheritable;
        sequence<int> add;
        sequence<int> remove;
        sequence<int> members;
    };

    dictionary<UserInfo, string> UserInfoMap;
    dictionary<int, string> NameMap;
    sequence<ACL> ACLList;
    sequence<Group> GroupList;

    // Exceptions
    exception MurmurException {};
    exception InvalidChannelException extends MurmurException {};
    exception InvalidUserException extends MurmurException {};
    exception ServerBootedException extends MurmurException {};
    exception InvalidSecretException extends MurmurException {};
    exception InvalidServerException {};

    /**
     * Virtual server interface — one per Murmur server instance.
     */
    interface Server {
        /**
         * Register a new user with username + password.
         * Returns the new user's Murmur ID.
         */
        int registerUser(UserInfoMap info)
            throws ServerBootedException, InvalidSecretException;

        /**
         * Remove a registered user.
         */
        void unregisterUser(int userid)
            throws ServerBootedException, InvalidSecretException, InvalidUserException;

        /**
         * Update a registered user's info (username, password, etc.)
         */
        void updateRegistration(int userid, UserInfoMap info)
            throws ServerBootedException, InvalidSecretException, InvalidUserException;

        /**
         * Get registration info for a single user.
         */
        idempotent UserInfoMap getRegistration(int userid)
            throws ServerBootedException, InvalidSecretException, InvalidUserException;

        /**
         * List all registered users matching the filter string.
         * Returns map of Murmur user ID → username.
         */
        idempotent NameMap getRegisteredUsers(string filter)
            throws ServerBootedException, InvalidSecretException;

        /**
         * Set the ACL for a channel.
         * acls: list of ACL entries
         * groups: list of group definitions
         * inherit: whether to inherit ACLs from parent channel
         */
        idempotent void setACL(int channelid, ACLList acls, GroupList groups, bool inherit)
            throws ServerBootedException, InvalidSecretException, InvalidChannelException;

        /**
         * Get the ACL for a channel.
         */
        idempotent void getACL(int channelid, out ACLList acls, out GroupList groups, out bool inherit)
            throws ServerBootedException, InvalidSecretException, InvalidChannelException;
    };

    /**
     * Meta interface — entry point for the ICE API.
     * Access via: Meta:tcp -h <host> -p <port>
     */
    interface Meta {
        /**
         * Get a virtual server by ID (1 = first/default server).
         */
        idempotent Server* getServer(int id)
            throws InvalidServerException;
    };
};
