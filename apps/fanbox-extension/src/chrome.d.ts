declare namespace chrome {
  namespace permissions {
    function request(permissions: {
      readonly origins?: readonly string[];
    }): Promise<boolean>;
  }

  namespace action {
    const onClicked: {
      addListener(listener: () => void): void;
    };
  }

  namespace storage {
    namespace session {
      function get(keys: string): Promise<Record<string, unknown>>;
      function set(items: Record<string, unknown>): Promise<void>;
    }
  }

  namespace cookies {
    type SameSite = "unspecified" | "no_restriction" | "lax" | "strict";
    type Cookie = {
      readonly name: string;
      readonly value: string;
      readonly domain: string;
      readonly path: string;
      readonly secure: boolean;
      readonly httpOnly: boolean;
      readonly sameSite: SameSite;
      readonly expirationDate?: number;
    };
    function getAll(details: {
      readonly domain: string;
    }): Promise<readonly Cookie[]>;
  }

  namespace runtime {
    const onInstalled: {
      addListener(listener: () => void): void;
    };
    function openOptionsPage(): Promise<void>;
  }
}
