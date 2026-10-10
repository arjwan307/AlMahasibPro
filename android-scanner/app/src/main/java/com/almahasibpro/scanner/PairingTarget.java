package com.almahasibpro.scanner;

import java.net.URI;

/** The QR carries the reachable server and shift token together. */
public final class PairingTarget {
    public final String origin;
    public final String token;
    private PairingTarget(String origin, String token) { this.origin = origin; this.token = token; }
    public static PairingTarget parse(String value) {
        try {
            URI uri = new URI(value);
            String token = uri.getFragment();
            if (!"https".equals(uri.getScheme()) || uri.getHost() == null || uri.getUserInfo() != null
                || uri.getQuery() != null || !("/market-scanner.html".equals(uri.getPath()) || "/retail/market-scanner.html".equals(uri.getPath()))
                || uri.getPort() < -1 || uri.getPort() == 0 || uri.getPort() > 65535
                || token == null || !token.matches("[a-fA-F0-9]{32}")) return null;
            String productPath = uri.getPath().startsWith("/retail/") ? "/retail" : "";
            return new PairingTarget("https://" + uri.getRawAuthority() + productPath, token);
        } catch (Exception error) { return null; }
    }
}
