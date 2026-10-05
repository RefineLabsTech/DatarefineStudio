"""Offline value dictionaries + header aliases for schema detection."""

from __future__ import annotations

import re

def norm_header(name: str) -> str:
    s = (name or "").strip().lower()
    s = s.replace("&", "and")
    s = re.sub(r"[^a-z0-9]+", "", s)
    return s


# Normalized header → schema class. Values still outrank headers.
HEADER_ALIASES: dict[str, str] = {}

def _alias(kind: str, *names: str) -> None:
    for n in names:
        HEADER_ALIASES[norm_header(n)] = kind

_alias("Name", "name", "full name", "fullname", "full_name", "customer name", "client name",
       "person", "person name", "first name", "firstname", "last name", "lastname",
       "given name", "surname", "contact name", "employee name", "user name", "username",
       "display name", "legal name")
_alias("Gender", "gender", "sex", "male female")
_alias("Age", "age", "ages", "age years")
_alias("Date", "date", "dob", "date of birth", "birth date", "birthdate", "birthday",
       "signup", "sign up", "sign-up", "signed up", "registered", "registered at",
       "created", "created at", "created on", "createdate", "create date",
       "updated", "updated at", "join date", "joined", "start date", "startdate",
       "end date", "enddate", "issue date", "expiry", "expire", "expiry date",
       "order date", "payment date", "trans date", "transaction date", "due date",
       "invoice date")
_alias("DateTime", "datetime", "timestamp", "time stamp", "createdat", "updatedat",
       "logged at", "event time")
_alias("Email", "email", "e-mail", "e mail", "email address", "mail", "emailid", "email id")
_alias("Phone", "phone", "phone number", "phonenumber", "mobile", "mobile no", "mobileno",
       "mobile number", "cell", "cellphone", "telephone", "tel", "whatsapp", "fax",
       "contact no", "contact number", "phone no")
_alias("URL", "url", "website", "web site", "homepage", "web", "link", "href", "domain")
_alias("Country", "country", "nation", "country name", "country code", "nationality",
       "countryiso", "iso country")
_alias("City", "city", "town", "municipality", "district", "zilla")
_alias("Postal Code", "zip", "zipcode", "zip code", "postal", "postal code", "postcode",
       "post code", "pin", "pincode")
_alias("Address", "address", "street", "street address", "addr", "location address",
       "billing address", "shipping address")
_alias("ID", "id", "customer id", "client id", "user id", "userid", "invoice",
       "invoice no", "invoice number", "invoiceno", "sku", "sku id", "order id",
       "orderid", "order no", "employee id", "empid", "account id", "ref", "reference")
_alias("UUID", "uuid", "guid", "uuid v4")
_alias("Currency", "currency", "currency code", "ccy", "fx")
_alias("Amount", "amount", "amt", "price", "cost", "total", "subtotal", "balance",
       "revenue", "salary", "fee", "charge", "payment", "paid")
_alias("Percent", "percent", "percentage", "pct", "tax rate", "rate %", "discount")
_alias("Category", "status", "state", "type", "kind", "category", "department",
       "dept", "segment", "tier", "level", "flag", "stage")
_alias("Boolean", "active", "enabled", "is active", "flag", "yes no", "true false")
_alias("Integer", "count", "qty", "quantity", "units", "n")
_alias("Year", "year", "yr", "yyyy")
_alias("Month", "month", "mm")

COUNTRY_VALUES = {
    "afghanistan", "albania", "algeria", "andorra", "angola", "argentina", "armenia",
    "australia", "austria", "azerbaijan", "bahamas", "bahrain", "bangladesh", "barbados",
    "belarus", "belgium", "belize", "benin", "bhutan", "bolivia", "bosnia", "botswana",
    "brazil", "brunei", "bulgaria", "burkina faso", "burundi", "cambodia", "cameroon",
    "canada", "chile", "china", "colombia", "congo", "costa rica", "croatia", "cuba",
    "cyprus", "czech", "czechia", "denmark", "djibouti", "dominica", "dominican republic",
    "ecuador", "egypt", "el salvador", "estonia", "eswatini", "ethiopia", "fiji", "finland",
    "france", "gabon", "gambia", "georgia", "germany", "ghana", "greece", "grenada",
    "guatemala", "guinea", "guyana", "haiti", "honduras", "hungary", "iceland", "india",
    "indonesia", "iran", "iraq", "ireland", "israel", "italy", "jamaica", "japan", "jordan",
    "kazakhstan", "kenya", "kuwait", "kyrgyzstan", "laos", "latvia", "lebanon", "lesotho",
    "liberia", "libya", "lithuania", "luxembourg", "madagascar", "malawi", "malaysia",
    "maldives", "mali", "malta", "mauritania", "mauritius", "mexico", "moldova", "monaco",
    "mongolia", "montenegro", "morocco", "mozambique", "myanmar", "namibia", "nepal",
    "netherlands", "holland", "new zealand", "nicaragua", "niger", "nigeria", "north korea",
    "north macedonia", "norway", "oman", "pakistan", "palestine", "panama", "papua new guinea",
    "paraguay", "peru", "philippines", "poland", "portugal", "qatar", "romania", "russia",
    "rwanda", "saudi arabia", "senegal", "serbia", "singapore", "slovakia", "slovenia",
    "somalia", "south africa", "south korea", "spain", "sri lanka", "sudan", "sweden",
    "switzerland", "syria", "taiwan", "tajikistan", "tanzania", "thailand", "togo",
    "trinidad", "tunisia", "turkey", "turkiye", "turkmenistan", "uganda", "ukraine",
    "united arab emirates", "uae", "united kingdom", "uk", "great britain", "england",
    "scotland", "wales", "united states", "united states of america", "usa", "u.s.", "u.s.a.",
    "uruguay", "uzbekistan", "venezuela", "vietnam", "yemen", "zambia", "zimbabwe",
    "korea", "south korea", "republic of korea", "ivory coast", "cote divoire",
    "hong kong", "macau", "palestine", "vatican",
}
COUNTRY_CODES = {
    "af", "al", "dz", "ad", "ao", "ar", "am", "au", "at", "az", "bs", "bh", "bd", "bb",
    "by", "be", "bz", "bj", "bt", "bo", "ba", "bw", "br", "bn", "bg", "bf", "bi", "kh",
    "cm", "ca", "cl", "cn", "co", "cg", "cr", "hr", "cu", "cy", "cz", "dk", "dj", "dm",
    "do", "ec", "eg", "sv", "ee", "sz", "et", "fj", "fi", "fr", "ga", "gm", "ge", "de",
    "gh", "gr", "gd", "gt", "gn", "gy", "ht", "hn", "hu", "is", "in", "id", "ir", "iq",
    "ie", "il", "it", "jm", "jp", "jo", "kz", "ke", "kw", "kg", "la", "lv", "lb", "ls",
    "lr", "ly", "lt", "lu", "mg", "mw", "my", "mv", "ml", "mt", "mr", "mu", "mx", "md",
    "mc", "mn", "me", "ma", "mz", "mm", "na", "np", "nl", "nz", "ni", "ne", "ng", "kp",
    "mk", "no", "om", "pk", "ps", "pa", "pg", "py", "pe", "ph", "pl", "pt", "qa", "ro",
    "ru", "rw", "sa", "sn", "rs", "sg", "sk", "si", "so", "za", "kr", "es", "lk", "sd",
    "se", "ch", "sy", "tw", "tj", "tz", "th", "tg", "tt", "tn", "tr", "tm", "ug", "ua",
    "ae", "gb", "us", "uy", "uz", "ve", "vn", "ye", "zm", "zw", "hk", "mo", "uk",
}

CITY_VALUES = {
    "dhaka", "chittagong", "chattogram", "sylhet", "khulna", "rajshahi", "barisal", "barishal",
    "rangpur", "mymensingh", "comilla", "cumilla", "gazipur", "narayanganj", "coxs bazar",
    "cox's bazar", "bogura", "bogra", "jessore", "jashore", "dinajpur", "pabna", "tangail",
    "narsingdi", "faridpur", "kushtia", "noakhali", "feni", "chandpur", "lakshmipur",
    "new york", "los angeles", "chicago", "houston", "phoenix", "philadelphia", "san antonio",
    "san diego", "dallas", "san jose", "austin", "seattle", "denver", "boston", "miami",
    "london", "manchester", "birmingham", "leeds", "glasgow", "edinburgh", "liverpool",
    "paris", "lyon", "marseille", "berlin", "munich", "hamburg", "frankfurt", "cologne",
    "madrid", "barcelona", "rome", "milan", "naples", "amsterdam", "rotterdam", "brussels",
    "zurich", "geneva", "vienna", "prague", "warsaw", "budapest", "lisbon", "dublin",
    "stockholm", "oslo", "copenhagen", "helsinki", "athens", "istanbul", "ankara",
    "dubai", "abu dhabi", "sharjah", "doha", "riyadh", "jeddah", "mecca", "medina",
    "kuwait city", "manama", "muscat", "amman", "beirut", "cairo", "alexandria", "casablanca",
    "lagos", "nairobi", "johannesburg", "cape town", "accra", "addis ababa",
    "mumbai", "delhi", "new delhi", "bangalore", "bengaluru", "hyderabad", "chennai",
    "kolkata", "pune", "ahmedabad", "jaipur", "lucknow", "kanpur", "nagpur", "indore",
    "karachi", "lahore", "islamabad", "rawalpindi", "kathmandu", "colombo",
    "beijing", "shanghai", "shenzhen", "guangzhou", "hong kong", "taipei", "seoul",
    "tokyo", "osaka", "kyoto", "singapore", "kuala lumpur", "jakarta", "bangkok",
    "hanoi", "ho chi minh", "manila", "sydney", "melbourne", "brisbane", "perth",
    "auckland", "wellington", "toronto", "vancouver", "montreal", "ottawa", "calgary",
    "mexico city", "sao paulo", "rio de janeiro", "buenos aires", "lima", "bogota",
    "santiago", "moscow", "saint petersburg", "kyiv", "minsk",
}

CURRENCY_CODES = {
    "usd", "eur", "gbp", "jpy", "cny", "inr", "bdt", "cad", "aud", "chf", "hkd", "sgd",
    "krw", "brl", "mxn", "zar", "nzd", "sek", "nok", "dkk", "try", "rub", "aed", "sar",
    "qar", "kwd", "egp", "ngn", "kes", "pkr", "lkr", "npr", "thb", "vnd", "idr", "myr",
    "php", "pln", "czk", "huf", "ron", "ils", "clp", "cop", "pen", "ars", "twd",
}
CURRENCY_WORDS = {
    "dollar", "dollars", "euro", "euros", "pound", "pounds", "yen", "yuan", "rupee",
    "rupees", "taka", "franc", "won", "peso", "pesos", "dirham", "riyal",
}

GENDER_VALUES = {
    "male", "female", "m", "f", "man", "woman", "men", "women", "boy", "girl",
    "other", "non-binary", "nonbinary", "nb", "unknown", "prefer not to say",
    "trans", "transgender",
}

STATUS_VALUES = {
    "active", "inactive", "pending", "complete", "completed", "open", "closed",
    "success", "failed", "error", "cancelled", "canceled", "draft", "published",
    "yes", "no", "true", "true", "false", "y", "n", "on", "off", "enabled", "disabled",
    "new", "old", "paid", "unpaid", "approved", "rejected", "hold", "processing",
}

BOOLEAN_VALUES = {
    "true", "false", "yes", "no", "y", "n", "1", "0", "t", "f", "on", "off",
    "enabled", "disabled", "active", "inactive",
}
