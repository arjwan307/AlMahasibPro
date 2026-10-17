import com.almahasibpro.scanner.PairingTarget;
public class PairingTargetTest {
    private static final String TOKEN = "abcdef0123456789abcdef0123456789";
    private static int cases;
    private static void accept(String url, String origin, String token) {
        PairingTarget target = PairingTarget.parse(url);
        if (target == null || !origin.equals(target.origin) || !token.equals(target.token)) throw new AssertionError(url);
        cases++;
    }
    private static void reject(String url) {
        if (PairingTarget.parse(url) != null) throw new AssertionError("Accepted unsafe pairing URL: " + url);
        cases++;
    }
    public static void main(String[] args) {
        for(String host : new String[]{"192.168.1.20", "10.0.0.15", "172.16.0.1", "172.31.255.254"})
            accept("http://"+host+":3765/market-scanner.html#"+TOKEN,"http://"+host+":3765",TOKEN);
        accept("http://192.168.1.20:3765/retail/market-scanner.html#012345","http://192.168.1.20:3765/retail","012345");
        accept("https://almahasibpro.onrender.com/market-scanner.html#"+TOKEN,"https://almahasibpro.onrender.com",TOKEN);
        accept("https://example.com/retail/market-scanner.html#"+TOKEN,"https://example.com/retail",TOKEN);
        for(String host:new String[]{"127.0.0.1","localhost","0.0.0.0","8.8.8.8","192.168.1.999","192.168.01.20","172.15.0.1","172.32.0.1","[::1]","2130706433","example.com"})
            reject("http://"+host+":3765/market-scanner.html#"+TOKEN);
        reject("http://user@192.168.1.20:3765/market-scanner.html#"+TOKEN);
        reject("http://192.168.1.20:0/market-scanner.html#"+TOKEN);
        reject("http://192.168.1.20:65536/market-scanner.html#"+TOKEN);
        reject("http://192.168.1.20/market-scanner.html?redirect=evil#"+TOKEN);
        reject("http://192.168.1.20/other.html#"+TOKEN);
        reject("http://192.168.1.20/market-scanner.html#12345");
        reject("javascript:alert(1)"); reject(null);
        System.out.println("Passed " + cases + " pairing URL cases");
    }
}
