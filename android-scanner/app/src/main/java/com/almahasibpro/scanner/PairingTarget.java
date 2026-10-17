package com.almahasibpro.scanner;

import java.net.URI;

/** QR supplies both the server address and its pairing credential. */
public final class PairingTarget {
    public final String origin;
    public final String token;
    private PairingTarget(String origin, String token) { this.origin = origin; this.token = token; }
    public static boolean isPrivateIpv4(String host) {
        if (host == null || !host.matches("[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+")) return false;
        String[] parts = host.split("\\.");
        int[] ip = new int[4];
        try {
            for (int i=0;i<4;i++) {
                ip[i]=Integer.parseInt(parts[i]);
                if(ip[i]>255 || !parts[i].equals(String.valueOf(ip[i]))) return false;
            }
        } catch (NumberFormatException error) { return false; }
        return ip[0]==10 || (ip[0]==192 && ip[1]==168) || (ip[0]==172 && ip[1]>=16 && ip[1]<=31);
    }
    public static PairingTarget parse(String value) {
        try {
            URI uri = new URI(value);
            String token = uri.getFragment();
            boolean secure = "https".equals(uri.getScheme());
            boolean local = "http".equals(uri.getScheme()) && isPrivateIpv4(uri.getHost());
            if ((!secure && !local) || uri.getHost() == null || uri.getUserInfo() != null
                || uri.getQuery() != null || !("/market-scanner.html".equals(uri.getPath()) || "/retail/market-scanner.html".equals(uri.getPath()))
                || uri.getPort() < -1 || uri.getPort() == 0 || uri.getPort() > 65535
                || token == null || !token.matches("([a-fA-F0-9]{32}|[0-9]{6})")) return null;
            String productPath = uri.getPath().startsWith("/retail/") ? "/retail" : "";
            return new PairingTarget(uri.getScheme() + "://" + uri.getRawAuthority() + productPath, token);
        } catch (Exception error) { return null; }
    }
}
